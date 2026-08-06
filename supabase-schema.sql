-- ============================================================
-- 공유 캘린더 - Supabase 스키마
-- Supabase 프로젝트의 SQL Editor에서 이 파일 전체를 실행하세요.
-- ============================================================

-- 1) 프로필 (auth.users 확장)
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  display_name text not null,
  created_at timestamptz default now()
);

alter table profiles enable row level security;

create policy "본인 프로필은 누구나 조회 가능"
  on profiles for select
  using (true);

create policy "본인 프로필만 수정 가능"
  on profiles for update
  using (auth.uid() = id);

-- 회원가입 시 auth.users -> profiles 자동 생성 트리거
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  );
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 2) 캘린더 (그룹 단위)
create table if not exists calendars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null,
  owner_id uuid references profiles(id) on delete set null,
  created_at timestamptz default now()
);

alter table calendars enable row level security;

-- 3) 캘린더 멤버 (가입 테이블 + 멤버별 색상)
create table if not exists calendar_members (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  color text not null default 'raspberry',
  joined_at timestamptz default now(),
  unique (calendar_id, user_id)
);

alter table calendar_members enable row level security;

-- 헬퍼: 내가 이 캘린더의 멤버인지 확인
create or replace function public.is_calendar_member(cal_id uuid)
returns boolean as $$
  select exists (
    select 1 from calendar_members
    where calendar_id = cal_id and user_id = auth.uid()
  );
$$ language sql security definer stable;

create policy "내가 속한 캘린더만 조회"
  on calendars for select
  using (public.is_calendar_member(id));

-- insert 직후 .select()로 결과를 돌려받으려면, 방금 만든 시점엔 아직
-- calendar_members에 내 행이 없으므로 오너는 항상 조회 가능하도록 별도 허용
create policy "오너는 자신이 만든 캘린더는 항상 조회 가능"
  on calendars for select
  using (auth.uid() = owner_id);

create policy "로그인한 사용자는 캘린더 생성 가능"
  on calendars for insert
  with check (auth.uid() = owner_id);

create policy "오너만 캘린더 이름 수정 가능"
  on calendars for update
  using (auth.uid() = owner_id);

create policy "오너만 캘린더 삭제 가능"
  on calendars for delete
  using (auth.uid() = owner_id);

create policy "같은 캘린더 멤버끼리 멤버 목록 조회"
  on calendar_members for select
  using (public.is_calendar_member(calendar_id));

create policy "로그인한 사용자는 자신을 멤버로 추가 가능(가입/초대코드 참여)"
  on calendar_members for insert
  with check (auth.uid() = user_id);

create policy "본인 멤버 정보만 수정 가능(이름/색상)"
  on calendar_members for update
  using (auth.uid() = user_id);

create policy "본인은 탈퇴 가능, 오너는 멤버 제거 가능"
  on calendar_members for delete
  using (
    auth.uid() = user_id
    or auth.uid() = (select owner_id from calendars where id = calendar_id)
  );

-- 4) 일정
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  member_id uuid references calendar_members(id) on delete set null,
  event_date date not null,
  event_time text,
  title text not null,
  note text,
  created_at timestamptz default now()
);

alter table events enable row level security;

create policy "캘린더 멤버는 일정 조회 가능"
  on events for select
  using (public.is_calendar_member(calendar_id));

create policy "캘린더 멤버는 일정 추가 가능"
  on events for insert
  with check (public.is_calendar_member(calendar_id));

create policy "캘린더 멤버는 일정 수정 가능"
  on events for update
  using (public.is_calendar_member(calendar_id));

create policy "캘린더 멤버는 일정 삭제 가능"
  on events for delete
  using (public.is_calendar_member(calendar_id));

-- 5) 댓글 / 메모
create table if not exists event_comments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references events(id) on delete cascade,
  member_id uuid references calendar_members(id) on delete set null,
  text text not null,
  created_at timestamptz default now()
);

alter table event_comments enable row level security;

create policy "캘린더 멤버는 댓글 조회 가능"
  on event_comments for select
  using (
    exists (
      select 1 from events e
      where e.id = event_id and public.is_calendar_member(e.calendar_id)
    )
  );

create policy "캘린더 멤버는 댓글 작성 가능"
  on event_comments for insert
  with check (
    exists (
      select 1 from events e
      where e.id = event_id and public.is_calendar_member(e.calendar_id)
    )
  );

-- 6) 실시간 동기화를 위한 Realtime 활성화
alter publication supabase_realtime add table events;
alter publication supabase_realtime add table event_comments;
alter publication supabase_realtime add table calendar_members;

-- ============================================================
-- 7) 날짜별 사진 보관
-- ============================================================
-- ⚠️ 이 SQL을 실행하기 전에, Supabase 대시보드 → Storage 에서
--    'calendar-photos' 라는 이름의 버킷을 먼저 만들어주세요. (Public 여부는 Private 권장)

create table if not exists day_photos (
  id uuid primary key default gen_random_uuid(),
  calendar_id uuid not null references calendars(id) on delete cascade,
  member_id uuid references calendar_members(id) on delete set null,
  photo_date date not null,
  storage_path text not null,
  created_at timestamptz default now()
);

alter table day_photos enable row level security;

create policy "캘린더 멤버는 사진 메타데이터 조회 가능"
  on day_photos for select
  using (public.is_calendar_member(calendar_id));

create policy "캘린더 멤버는 사진 메타데이터 추가 가능"
  on day_photos for insert
  with check (public.is_calendar_member(calendar_id));

create policy "캘린더 멤버는 사진 삭제 가능"
  on day_photos for delete
  using (public.is_calendar_member(calendar_id));

alter publication supabase_realtime add table day_photos;

-- Storage(버킷) 자체에 대한 접근 정책
-- 파일 경로를 '{calendar_id}/{date}/{uuid}.jpg' 형태로 저장하는 것을 전제로 합니다.
create policy "캘린더 멤버는 사진 파일 조회 가능"
  on storage.objects for select
  using (
    bucket_id = 'calendar-photos'
    and public.is_calendar_member((storage.foldername(name))[1]::uuid)
  );

create policy "캘린더 멤버는 사진 파일 업로드 가능"
  on storage.objects for insert
  with check (
    bucket_id = 'calendar-photos'
    and public.is_calendar_member((storage.foldername(name))[1]::uuid)
  );

create policy "캘린더 멤버는 사진 파일 삭제 가능"
  on storage.objects for delete
  using (
    bucket_id = 'calendar-photos'
    and public.is_calendar_member((storage.foldername(name))[1]::uuid)
  );

-- ============================================================
-- 8) 근태 유형 (연차/반차) — 일정에 태그처럼 붙는 선택 항목
-- 휴가는 연차와 의미가 겹쳐서 연차로 통일합니다.
-- (이미 이 SQL을 실행해서 leave_type='vacation'인 기존 데이터가 있어도
--  아래 update 문이 자동으로 연차로 옮겨줍니다.)
-- ============================================================
alter table events add column if not exists leave_type text;
update events set leave_type = 'annual' where leave_type = 'vacation';
alter table events drop constraint if exists events_leave_type_check;
alter table events add constraint events_leave_type_check
  check (leave_type is null or leave_type in ('annual','half','half_am','half_pm'));
-- 'half'(오전/오후 구분 이전의 옛 반차 데이터)는 그대로 두고, 등록 화면에서만
-- 앞으로는 half_am/half_pm 중 하나로 저장하도록 바뀌었습니다.

-- ============================================================
-- 9) 일정 종료일/종료시각 — 여러 날에 걸치는 일정, 시작~종료 시간 입력 지원
-- 기존 행은 end_date가 비어있으면 앱에서 event_date와 같은 날로 취급합니다.
-- ============================================================
alter table events add column if not exists end_date date;
alter table events add column if not exists end_time text;

-- ============================================================
-- 10) 초대 코드로 캘린더 찾기 (멤버가 아직 아니어도 코드로만 조회 가능해야 참여 가능)
-- calendars 테이블의 RLS는 "멤버이거나 오너인 캘린더만 조회"라서,
-- 참여 전(=아직 멤버가 아닌) 사용자는 코드가 맞아도 일반 select로는 못 찾습니다.
-- 그래서 코드 일치 여부만 확인해주는 별도 함수로 우회합니다.
-- ============================================================
create or replace function public.find_calendar_by_invite_code(p_code text)
returns table(id uuid, name text, invite_code text, owner_id uuid) as $$
  select id, name, invite_code, owner_id from calendars where invite_code = p_code;
$$ language sql security definer stable;

-- ============================================================
-- 11) 일정 구분 (업무/휴가) — 근태 유형(연차/반차)과 별개로,
-- 일정 자체를 업무/휴가로 나누기 위한 항목입니다. 기본값은 업무입니다.
-- ============================================================
alter table events add column if not exists category text not null default 'work';
update events set category = 'leave' where leave_type is not null;
alter table events drop constraint if exists events_category_check;
alter table events add constraint events_category_check
  check (category in ('work','leave'));

-- ============================================================
-- 12) TimeTree 일정 가져오기 (읽기 전용 수동 가져오기)
-- TimeTree에서 내보낸 .ics 파일을 앱에서 업로드하면 external_uid 기준으로
-- upsert(같은 일정 다시 가져오면 새로 만들지 않고 갱신)합니다.
-- ============================================================
alter table events add column if not exists source text;
alter table events add column if not exists external_uid text;
create unique index if not exists events_external_uid_idx
  on events(calendar_id, external_uid) where external_uid is not null;

-- ============================================================
-- 13) 구글 캘린더 자동 동기화 (읽기 전용, 몇 분 주기)
-- refresh_token이 담기는 민감한 테이블이라 RLS만 켜두고 정책은 하나도 안 둡니다.
-- → 프론트엔드(로그인 사용자 권한)는 이 테이블에 절대 직접 접근 못 하고,
--   오직 서비스 롤 키를 쓰는 Edge Function(google-calendar, google-calendar-sync)만 다룰 수 있어요.
-- ============================================================
create table if not exists google_calendar_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  calendar_id uuid not null references calendars(id) on delete cascade,
  refresh_token text not null,
  google_email text,
  sync_token text,
  last_synced_at timestamptz,
  created_at timestamptz default now(),
  unique(user_id, calendar_id)
);
alter table google_calendar_connections enable row level security;

-- ============================================================
-- 14) 12번에서 만든 부분(partial) unique index 수정
-- "where external_uid is not null" 조건이 있으면 Postgres가 upsert의
-- ON CONFLICT (calendar_id, external_uid) 를 인식하지 못해 저장이 실패합니다.
-- (external_uid가 NULL인 행끼리는 애초에 유니크 제약을 어겨도 충돌로 안 잡히는
--  게 Postgres 기본 동작이라, WHERE 조건 없이 만들어도 동일하게 잘 동작합니다.)
-- ============================================================
drop index if exists events_external_uid_idx;
create unique index if not exists events_external_uid_idx on events(calendar_id, external_uid);

-- ============================================================
-- 15) 일정 구분에 "미팅룸 예약", "차량 이용" 추가
-- ============================================================
alter table events drop constraint if exists events_category_check;
alter table events add constraint events_category_check
  check (category in ('work','leave','meeting_room','vehicle'));

-- 끝. 이 아래는 실행할 필요 없습니다.
