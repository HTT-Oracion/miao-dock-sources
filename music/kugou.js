/*
 * 酷狗音乐 JS 源。
 *
 * · 搜索 / 榜单 / 歌单走 mobilecdn / songsearch（免登录）
 * · 歌词走 krcs 两段式（search 拿 id+accesskey → download 取 base64 正文）
 * · 播放地址走 gateway /v5/url：需要 userid / mid / token 参与 key 与 signature 签名
 *   —— 票据从 App 注入的会话 Cookie 解析（getSessionCookie），未登录直接回 null
 *     （与内置实现同语义：播放器跳过）。
 *
 * 网关签名口径与内置 Dart 版逐字一致：
 * · key = md5(hash + salt2 + appid + mid + userid)
 * · signature = md5(salt1 + 按 key 排序的 k=v 串 + salt1)
 */
const KG_H5_SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt';
const KG_SIGN_SALT = '57ae12eb6890223e355ccfcb74edf70d';
const KG_WEB_APPID = 1014;

function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, '').trim();
}

class KugouSource extends MusicSourceBase {
  name = '酷狗';
  platform = 'kugou';
  key = 'kugou';
  version = '1.0.0';
  baseUrl = 'https://www.kugou.com';

  referer = 'https://www.kugou.com/';

  // WebView 登录声明。warmup：登录后缺播放票据时导航个人中心补 Cookie。
  loginUrl = 'https://www.kugou.com/';
  loginCookieDomains = 'kugou.com';
  loginCookieNames = 'token,userid';
  loginWarmupUrl = 'https://www.kugou.com/newuc/user/uc/type=edit';

  async searchSongs({ keyword, limit = 20, offset = 0 }) {
    const pageSize = Math.max(1, Math.min(limit, 20));
    const page = Math.floor(offset / pageSize) + 1;
    const q = formEncode({
      keyword: keyword, page: page, pagesize: pageSize, userid: '-1',
      clientver: 2000, platform: 'WebFilter', tag: 'em', filter: 2,
      iscorrection: 1, privilege_filter: 0, filter_ver: 2,
      appid: KG_WEB_APPID, mid: '1', token: '',
    });
    const json = await this.getJson('http://songsearch.kugou.com/song_search_v2?' + q);
    return { songs: (json.data && json.data.lists || []).map((it) => this.songFromSearch(it)).filter((s) => s && s.title) };
  }

  async searchPlaylists({ keyword, limit = 12 }) {
    const q = formEncode({ format: 'json', keyword: keyword, page: 1, pagesize: limit, showtype: 1 });
    const json = await this.getJson('http://mobilecdn.kugou.com/api/v3/search/special?' + q);
    return { playlists: (json.data && json.data.info || []).map((it) => this.playlistFromV3Special(it)).filter((p) => p && p.name) };
  }

  async charts() {
    const json = await this.getJson('http://mobilecdn.kugou.com/api/v3/rank/list?format=json&page=1&pagesize=100&withsong=0');
    return {
      charts: (json.data && json.data.info || []).map((it) => ({
        id: String(it.rankid || ''),
        name: String(it.rankname || ''),
        updateMeta: String(it.update_frequency || ''),
        coverUrl: String(it.banner7url || it.imgurl || ''),
      })).filter((c) => c.name),
    };
  }

  async chartDetail({ id }) {
    // rank/song 只给曲目，榜单名与封面从 rank/list 按 id 找回。
    const meta = await this.rankMeta(id);
    const q = formEncode({ format: 'json', rankid: id, page: 1, pagesize: 50, version: 8990 });
    const json = await this.getJson('http://mobilecdn.kugou.com/api/v3/rank/song?' + q);
    const info = json.data && json.data.info || [];
    return {
      meta: {
        id: String(id),
        name: meta ? meta.name : '',
        trackCount: info.length,
        description: meta ? meta.description : '',
        coverUrl: meta ? meta.coverUrl : '',
      },
      songs: info.map((it) => this.songFromV3(it)).filter((s) => s && s.title),
    };
  }

  async rankMeta(id) {
    try {
      const json = await this.getJson('http://mobilecdn.kugou.com/api/v3/rank/list?format=json&page=1&pagesize=100&withsong=0');
      const hit = (json.data && json.data.info || []).find((it) => String(it.rankid) === String(id));
      if (!hit) return null;
      return { name: String(hit.rankname || ''), description: String(hit.intro || hit.update_frequency || ''), coverUrl: String(hit.banner7url || hit.imgurl || '') };
    } catch (e) {
      return null;
    }
  }

  async playlistDetail({ id }) {
    const q = formEncode({ format: 'json', specialid: id, page: 1, pagesize: 50, version: 8990 });
    const json = await this.getJson('http://mobilecdn.kugou.com/api/v3/special/song?' + q);
    const data = json.data || {};
    const info = data.info || [];
    return {
      meta: { id: String(id), name: String(data.specialname || ''), trackCount: info.length, description: String(data.intro || '') },
      songs: info.map((it) => this.songFromV3(it)).filter((s) => s && s.title),
    };
  }

  async lyrics({ id }) {
    if (!id) return { lines: [] };
    const found = await this.getJson('https://krcs.kugou.com/search?' + formEncode({ ver: 1, man: 'yes', client: 'pc', keyword: '', duration: 0, hash: id }));
    const first = found.candidates && found.candidates[0];
    if (!first) return { lines: [] };
    const dl = await this.getJson('https://krcs.kugou.com/download?' + formEncode({
      ver: 1, client: 'pc', id: first.id, accesskey: first.accesskey, fmt: 'lrc', charset: 'utf8',
    }));
    const content = String(dl.content || '').replace(/\s+/g, '');
    if (!content) return { lines: [] };
    const text = Convert.decodeUtf8(Convert.decodeBase64(content));
    return { lrc: text };
  }

  async songUrl({ id, mediaId }) {
    const cookie = await getSessionCookie();
    const auth = this.parseAuth(cookie);
    if (!auth) return { url: null };
    const params = {
      appid: String(KG_WEB_APPID), clientver: '20000',
      clienttime: String(Date.now()), mid: auth.mid, userid: auth.userId,
      uuid: '-', dfid: '-', album_id: '', area_code: '1',
      hash: String(id || '').toLowerCase(), ssa_flag: 'is_fromtrack',
      version: '11430', quality: '128', album_audio_id: String(mediaId || ''),
      behavior: 'play', pid: '2', cmd: '26', pidversion: '3001',
      IsFreePart: '1', cdnBackup: '1', module: '',
    };
    params.key = Convert.md5(String(id).toLowerCase() + KG_SIGN_SALT + KG_WEB_APPID + auth.mid + auth.userId);
    const pairs = Object.keys(params).sort().map((k) => k + '=' + params[k]).join('');
    params.signature = Convert.md5(KG_H5_SALT + pairs + KG_H5_SALT);
    const json = await this.getJson('https://gateway.kugou.com/v5/url?' + formEncode(params));
    const url = json.url && json.url[0];
    return { url: url ? String(url) : null };
  }

  /// 账户信息（对齐 miao-dock：昵称取 Cookie KuGoo 复合字段的 NickName；
  /// loggedIn 走 userid 有效判定；昵称缺失兜底「酷狗 {userid}」）。
  async loginInfo() {
    const cookie = await getSessionCookie();
    const auth = this.parseAuth(cookie);
    if (!auth || !auth.loggedInRaw) return { loggedIn: false, nick: '' };
    const kugooRaw = this.kugooField(cookie);
    let nick = '';
    if (kugooRaw) {
      try {
        const map = {};
        decodeURIComponent(kugooRaw).split('&').forEach((part) => {
          const i = part.indexOf('=');
          if (i > 0) map[part.substring(0, i).trim()] = part.substring(i + 1).trim();
        });
        nick = String(map.NickName || map.nickname || '');
      } catch (e) {
        nick = '';
      }
    }
    if (!nick) {
      // Cookie 明文键兜底（部分版本写在外面）。
      const jar = {};
      (cookie || '').split(';').forEach((part) => {
        const i = part.indexOf('=');
        if (i > 0) jar[part.substring(0, i).trim()] = part.substring(i + 1).trim();
      });
      nick = String(jar.NickName || jar.nickname || '');
    }
    if (!nick) nick = '酷狗 ' + (auth.userId || '用户');
    return { loggedIn: true, nick: nick };
  }

  /// 从 Cookie 串里取 KuGoo / kugou 复合字段原始值。
  kugooField(cookie) {
    const jar = {};
    (cookie || '').split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) jar[part.substring(0, i).trim()] = part.substring(i + 1).trim();
    });
    return jar.KuGoo || jar.kugou || jar.Kugou || '';
  }

  /// 用户歌单（H5 网关 /v7/get_all_list）：需登录；未登录返回空集。
  ///
  /// 签名与参数与内置 Dart 实现逐字一致：POST query 挂签名参数、body 为 JSON 串、
  /// 头带 x-router；签名 = md5(salt + 按 key 排序的 k=v（无分隔）+ body + salt)。
  async userPlaylists() {
    const cookie = await getSessionCookie();
    const auth = this.parseH5Auth(cookie);
    if (!auth) return { playlists: [] };
    const body = JSON.stringify({
      userid: Number(auth.userId) || 0, token: auth.token,
      total_ver: 979, type: 2, page: 1, pagesize: 50,
    });
    const now = String(Date.now());
    const params = {
      srcappid: '2919', clientver: '20000', clienttime: now, mid: auth.mid,
      uuid: now, dfid: auth.dfid, appid: String(KG_WEB_APPID),
      token: auth.token, userid: auth.userId, plat: '1',
    };
    const joined = Object.keys(params).sort().map((k) => k + '=' + params[k]).join('');
    params.signature = Convert.md5(KG_H5_SALT + joined + body + KG_H5_SALT);
    const json = await fetchJson(
      'POST',
      'https://gateway.kugou.com/v7/get_all_list?' + formEncode(params),
      Object.assign({}, this.formHeaders, { 'x-router': 'cloudlist.service.kugou.com' }),
      body,
    );
    const status = json.status;
    if (String(status) === '0' || status === 0) return { playlists: [] };
    const data = json.data || {};
    const info = data.info || (data.data && data.data.info) || [];
    return { playlists: info.map((it) => this.playlistFromV3Special(it)).filter((p) => p && p.name) };
  }

  /// H5 网关授权解析：KuGoo 复合字段优先，明文键兜底（对齐内置 Dart _parseH5Auth）。
  parseH5Auth(cookie) {
    const map = {};
    (cookie || '').split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) map[part.substring(0, i).trim()] = part.substring(i + 1).trim();
    });
    const compoundRaw = map.KuGoo || map.kugou || '';
    let compound = '';
    try { compound = decodeURIComponent(compoundRaw); } catch (e) { compound = compoundRaw; }
    const inner = {};
    compound.split('&').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) inner[part.substring(0, i).trim()] = part.substring(i + 1).trim();
    });
    function pick(keys) {
      for (const k of keys) {
        const v = inner[k] !== undefined ? inner[k] : map[k];
        if (v !== undefined && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    }
    const userId = pick(['KugooID', 'kugouID', 'userid', 'UserId']).replace(/[^0-9]/g, '');
    const token = pick(['t', 'token', 'T', 'Token']);
    if (!userId || !token) return null;
    return { userId: userId, mid: pick(['kg_mid', 'KG_MID']), token: token, dfid: pick(['kg_dfid', 'KG_DFID']) };
  }

  parseAuth(cookie) {
    const map = {};
    (cookie || '').split(';').forEach((part) => {
      const i = part.indexOf('=');
      if (i > 0) map[part.substring(0, i).trim()] = part.substring(i + 1).trim();
    });
    const userId = map.userid || map.UserId || '';
    const mid = map.mid || map.KugouID || '';
    const token = map.token || map.t || '';
    const hasKugoo = !!map.KuGoo;
    if ((!token || !userId) && !hasKugoo) return null;
    return { userId: userId, mid: mid || '1', token: token, loggedInRaw: true };
  }

  // ── 映射 ────────────────────────────────────────────────────────────────

  songFromSearch(it) {
    if (!it) return null;
    return {
      id: String(it.FileHash || '').toLowerCase(),
      title: stripHtml(it.SongName || it.FileName),
      artist: stripHtml(it.SingerName),
      album: stripHtml(it.AlbumName),
      durationMs: Number(it.Duration || 0) * 1000,
      mediaId: String(it.MixSongID || it.AlbumID || ''),
      coverUrl: String(it.AlbumImage || it.Image || it.cover || ''),
    };
  }

  songFromV3(it) {
    if (!it) return null;
    const filename = String(it.filename || '');
    const dash = filename.indexOf(' - ');
    const artist = dash > 0 ? filename.substring(0, dash) : String(it.singername || '');
    const title = dash > 0 ? filename.substring(dash + 3) : filename;
    return {
      id: String(it.hash || '').toLowerCase(),
      title: stripHtml(title),
      artist: stripHtml(artist),
      album: stripHtml(it.album_name),
      durationMs: Number(it.duration || 0) * 1000,
      mediaId: String(it.mixsongid || it.album_audio_id || ''),
      coverUrl: String(it.imgurl || it.sizable_cover || ''),
    };
  }

  playlistFromV3Special(it) {
    if (!it) return null;
    return {
      id: String(it.specialid || ''),
      name: String(it.specialname || ''),
      trackCount: Number(it.songcount || 0),
      playCountValue: Number(it.playcount || 0),
      description: String(it.nickname || ''),
      coverUrl: String(it.imgurl || it.img || ''),
    };
  }
}
