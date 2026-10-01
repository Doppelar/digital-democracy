/* ふだんは何も書きかえなくてOKです（公開の中継サーバーで動きます）。
 *
 * もっと安定させたいときだけ、Supabase を使えます（README の「Supabaseを使う場合」）。
 * そのときは下の2行に、Supabase の「Project Settings → API」の値を貼りつけてください。
 * anon（public）キーは公開しても大丈夫なキーです。service_role キーは絶対に貼らないでください。
 */
window.MACHI_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};
