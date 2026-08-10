// 주기적으로(Cron) 실행되는 함수: 연동된 모든 구글 계정의 일정을 가져와 events 테이블에 반영합니다.
// 사용자가 직접 호출하지 않고, Supabase 대시보드의 Cron Jobs가 몇 분마다 이 함수를 호출합니다.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

function pad(n: number) { return String(n).padStart(2, '0'); }

async function refreshAccessToken(refresh_token: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error_description || json.error || 'access token 갱신 실패');
  return json.access_token as string;
}

function toLocalDateTime(dt: { date?: string; dateTime?: string }): { date: string; time: string | null } {
  if (dt.date) return { date: dt.date, time: null };
  const d = new Date(dt.dateTime!);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

const LEAVE_LABELS: Record<string, string> = { annual: '연차', half_am: '오전 반차', half_pm: '오후 반차' };
/* 제목에 "오전 반차"/"오후 반차"/"연차"가 들어있으면 그 유형으로 인식 (앱에서 쓰는 근태 유형과 동일한 종류) */
function detectLeaveType(title: string): 'annual' | 'half_am' | 'half_pm' | null {
  if (title.includes('오전') && title.includes('반차')) return 'half_am';
  if (title.includes('오후') && title.includes('반차')) return 'half_pm';
  if (title.includes('연차')) return 'annual';
  return null;
}

/* 제목에 "미팅룸"/"차량"이 들어있으면 그 구분으로 자동 분류 (휴가가 아닌 경우에만 적용) */
function detectCategory(title: string): 'meeting_room' | 'vehicle' | null {
  if (title.includes('미팅룸')) return 'meeting_room';
  if (title.includes('차량')) return 'vehicle';
  return null;
}

Deno.serve(async (_req) => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const { data: connections, error } = await admin.from('google_calendar_connections').select('*');
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const results = [];
  for (const conn of connections || []) {
    try {
      const accessToken = await refreshAccessToken(conn.refresh_token);

      const { data: memberRow } = await admin.from('calendar_members')
        .select('id, profiles(display_name)')
        .eq('calendar_id', conn.calendar_id).eq('user_id', conn.user_id).maybeSingle();
      const memberId = memberRow?.id ?? null;
      const memberName = (memberRow?.profiles as { display_name?: string } | null)?.display_name ?? '';

      const params = new URLSearchParams({ singleEvents: 'true', maxResults: '250' });
      if (conn.sync_token) {
        params.set('syncToken', conn.sync_token);
      } else {
        const timeMin = new Date(); timeMin.setMonth(timeMin.getMonth() - 1);
        const timeMax = new Date(); timeMax.setMonth(timeMax.getMonth() + 6);
        params.set('timeMin', timeMin.toISOString());
        params.set('timeMax', timeMax.toISOString());
      }

      let url: string | null = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`;
      let nextSyncToken: string | null = null;
      const rows: Record<string, unknown>[] = [];
      const deletedIds: string[] = [];
      let syncTokenExpired = false;

      while (url) {
        const evRes: Response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        const evJson = await evRes.json();
        if (!evRes.ok) {
          if (evJson.error?.status === 'GONE') { syncTokenExpired = true; break; }
          throw new Error(evJson.error?.message || 'events.list 실패');
        }
        for (const item of evJson.items || []) {
          if (item.status === 'cancelled') { deletedIds.push(item.id); continue; }
          if (!item.start) continue;
          const start = toLocalDateTime(item.start);
          const end = item.end ? toLocalDateTime(item.end) : start;
          let endDate = end.date;
          if (!start.time && end.date > start.date) {
            const d = new Date(end.date + 'T00:00:00');
            d.setDate(d.getDate() - 1);
            endDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            if (endDate < start.date) endDate = start.date;
          }
          const rawTitle = item.summary || '(제목 없음)';
          const leaveType = detectLeaveType(rawTitle);
          const isLeave = !!leaveType;
          const detectedCategory = !isLeave ? detectCategory(rawTitle) : null;
          /* 휴가로 인식되면 앱에서 쓰는 "담당멤버 + 근태유형" 형식으로 제목을 다시 만듦 */
          const title = isLeave
            ? [memberName, LEAVE_LABELS[leaveType!]].filter(Boolean).join(' ')
            : rawTitle;
          rows.push({
            calendar_id: conn.calendar_id,
            member_id: memberId,
            event_date: start.date,
            end_date: endDate,
            event_time: start.time,
            end_time: start.time ? end.time : null,
            title,
            note: item.description || null,
            category: isLeave ? 'leave' : (detectedCategory ?? 'work'),
            leave_type: leaveType,
            source: 'google',
            external_uid: 'google:' + item.id,
          });
        }
        nextSyncToken = evJson.nextSyncToken ?? nextSyncToken;
        url = evJson.nextPageToken
          ? `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}&pageToken=${evJson.nextPageToken}`
          : null;
      }

      if (syncTokenExpired) {
        // syncToken이 만료됐으면 초기화만 하고, 다음 실행 때 처음부터(timeMin~timeMax) 다시 가져옵니다.
        await admin.from('google_calendar_connections').update({ sync_token: null }).eq('id', conn.id);
        results.push({ connection: conn.id, note: 'syncToken 만료, 다음 실행에서 재동기화' });
        continue;
      }

      if (rows.length) {
        const { error: upsertErr } = await admin.from('events').upsert(rows, { onConflict: 'calendar_id,external_uid' });
        if (upsertErr) throw new Error('events upsert 실패: ' + upsertErr.message);
      }
      if (deletedIds.length) {
        const { error: delErr } = await admin.from('events').delete()
          .eq('calendar_id', conn.calendar_id)
          .eq('source', 'google')
          .in('external_uid', deletedIds.map((id) => 'google:' + id));
        if (delErr) throw new Error('events delete 실패: ' + delErr.message);
      }
      await admin.from('google_calendar_connections')
        .update({ sync_token: nextSyncToken, last_synced_at: new Date().toISOString() })
        .eq('id', conn.id);

      results.push({ connection: conn.id, imported: rows.length, deleted: deletedIds.length });
    } catch (err) {
      results.push({ connection: conn.id, error: String(err) });
    }
  }
  return new Response(JSON.stringify({ results }), { headers: { 'Content-Type': 'application/json' } });
});
