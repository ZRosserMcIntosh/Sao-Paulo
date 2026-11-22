// São Paulo World · flying together: the relay live rooms use.
//
// Supabase Realtime, Broadcast and Presence only, on a public channel named
// after the room: players' browsers pass each other small messages through
// it. Nothing is stored and no database table is touched. It needs the
// project's URL and its publishable (public) key; both are meant to be seen.
//
// While `url` or `key` is empty, "Fly together" says live rooms are not
// switched on yet (and ?relay=local still plays between tabs of one browser).
export default {
  url: '',   // 'https://<project-ref>.supabase.co'
  key: '',   // 'sb_publishable_…' (or the project's legacy anon key)
  // Messages a second one room may cost. Supabase counts every message sent
  // AND every copy delivered, over the whole project: 100 a second on the
  // Free plan, 500 on Pro. Players send less often as a room fills to stay
  // under this (netstate.js BUDGET): 80 gives 12 updates a second each for
  // two players, 5 for four, about 1 for eight. On Pro, 400 is comfortable.
  roomEvents: 80,
};
