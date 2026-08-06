// 사용자가 직접 호출하는 함수: 구글 계정 연동(connect) / 상태 확인(status) / 연동 해제(disconnect)
// 프론트엔드에서 sb.functions.invoke('google-calendar', { body: { action, ... } }) 로 호출합니다.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization') || '';
    const jwt = authHeader.replace('Bearer ', '');
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await anonClient.auth.getUser(jwt);
    if (userErr || !userData?.user) return json({ error: '인증 실패' }, 401);
    const userId = userData.user.id;

    const body = await req.json().catch(() => ({}));
    const action = body.action;
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    if (action === 'status') {
      const { calendar_id } = body;
      if (!calendar_id) return json({ error: 'calendar_id 필요' }, 400);
      const { data } = await admin
        .from('google_calendar_connections')
        .select('google_email, last_synced_at')
        .eq('user_id', userId)
        .eq('calendar_id', calendar_id)
        .maybeSingle();
      return json({ connected: !!data, google_email: data?.google_email ?? null, last_synced_at: data?.last_synced_at ?? null });
    }

    if (action === 'disconnect') {
      const { calendar_id } = body;
      if (!calendar_id) return json({ error: 'calendar_id 필요' }, 400);
      await admin.from('google_calendar_connections').delete().eq('user_id', userId).eq('calendar_id', calendar_id);
      return json({ ok: true });
    }

    if (action === 'connect') {
      const { code, calendar_id, redirect_uri } = body;
      if (!code || !calendar_id || !redirect_uri) return json({ error: '필요한 값이 없습니다' }, 400);

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri,
          grant_type: 'authorization_code',
        }),
      });
      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok || !tokenJson.refresh_token) {
        return json({ error: 'Google 인증 실패: ' + (tokenJson.error_description || tokenJson.error || 'refresh_token 없음 (이미 연동된 적 있다면 구글 계정 권한에서 앱 액세스를 제거하고 다시 시도해주세요)') }, 400);
      }

      let googleEmail: string | null = null;
      try {
        const uiRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
          headers: { Authorization: `Bearer ${tokenJson.access_token}` },
        });
        const uiJson = await uiRes.json();
        googleEmail = uiJson.email || null;
      } catch (_e) { /* 이메일 조회 실패는 무시 */ }

      const { error: upErr } = await admin.from('google_calendar_connections').upsert(
        { user_id: userId, calendar_id, refresh_token: tokenJson.refresh_token, google_email: googleEmail, sync_token: null },
        { onConflict: 'user_id,calendar_id' }
      );
      if (upErr) return json({ error: 'DB 저장 실패: ' + upErr.message }, 500);
      return json({ ok: true, google_email: googleEmail });
    }

    return json({ error: '알 수 없는 action' }, 400);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
