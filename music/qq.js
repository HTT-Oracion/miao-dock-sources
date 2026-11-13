/*
 * QQ 音乐 JS 源。
 *
 * · 搜索 / 歌词 / 播放地址走 musicu.fcg（sign = qqSign，公共件在 prelude）
 * · 榜单是静态 topid 清单（与内置实现一致），曲目走 fcg_v8_toplist_cp
 * · 歌词正文是 base64（服务端新接口返回纯 base64 时），旧接口 nobase64=1 明文
 *
 * 未登录可播标准音质；无损 / Hi-Res 需要 Cookie（u.y.qq.com 域），App 注入后生效。
 */
const QQ_MUSICU = 'https://u.y.qq.com/cgi-bin/musicu.fcg';

const QQ_COMMON_COMM = {
  ct: '11', cv: '14090508', v: '14090508', tmeAppID: 'qqmusic', phonetype: 'EBG-AN10',
  os_ver: '12', OpenUDID: '0', QIMEI36: '0', udid: '0', chid: '0', aid: '0', oaid: '0',
  taid: '0', tid: '0', wid: '0', uid: '0', sid: '0', modeSwitch: '6', teenMode: '0',
  ui_mode: '2', nettype: '1020',
};

// 榜单 topid（与内置 Dart 版一致）。
const QQ_RANKS = [
  { id: '26', name: '热歌榜' },
  { id: '27', name: '新歌榜' },
  { id: '4', name: '流行指数榜' },
  { id: '62', name: '上升最快' },
  { id: '5', name: '内地榜' },
  { id: '6', name: '港台榜' },
  { id: '105', name: 'Oricon榜' },
  { id: '51', name: '潜力新星榜' },
  { id: '52', name: '原创榜' },
];

// 音质模板（与内置 Dart 版同序：逐档降级）。
const QQ_TEMPLATES = [
  { prefix: 'RS01', ext: '.flac', level: 'hires' },
  { prefix: 'F000', ext: '.flac', level: 'lossless' },
  { prefix: 'M800', ext: '.mp3', level: 'exhigh' },
  { prefix: 'M500', ext: '.mp3', level: 'standard' },
];

function stripHtml(text) {
  return String(text || '').replace(/<[^>]*>/g, '').trim();
}

function looksBase64(text) {
  const compact = text.replace(/\s+/g, '');
  return compact.length >= 8 && compact.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(compact) && text[0] !== '[';
}

class QqSource extends MusicSourceBase {
  name = 'QQ 音乐';
  platform = 'qq';
  key = 'qq';
  version = '1.0.0';
  baseUrl = 'https://u.y.qq.com';

  async searchSongs({ keyword, limit = 30, offset = 0 }) {
    const pageSize = Math.max(1, Math.min(limit, 30));
    const payload = {
      comm: QQ_COMMON_COMM,
      req: {
        module: 'music.search.SearchCgiService',
        method: 'DoSearchForQQMusicMobile',
        param: {
          search_type: 0,
          searchid: String(Date.now()) + '000000',
          query: keyword,
          page_num: Math.floor(offset / pageSize) + 1,
          num_per_page: pageSize,
          highlight: 0, nqc_flag: 0, multi_zhida: 0, cat: 2, grp: 1, sin: 0, sem: 0,
        },
      },
    };
    const json = await this.postJsonMusicu(payload);
    const body = json.req && json.req.data && json.req.data.body;
    const items = (body && (body.item_song || (body.song && body.song.list))) || [];
    return { songs: items.map((it) => this.song(it.track_info || it)).filter((s) => s && s.title) };
  }

  async searchPlaylists({ keyword, limit = 12 }) {
    const q = formEncode({
      picmid: 1, rnd: Date.now(), g_tk: 5381, loginUin: 0, hostUin: 0, format: 'json',
      inCharset: 'utf8', outCharset: 'utf-8', notice: 0, platform: 'yqq.json', needNewCode: 0,
      categoryId: 10000000, sortId: 5, sin: 0, ein: limit,
    });
    const json = await this.getJson('https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?' + q);
    return { playlists: (json.data && json.data.list || []).map((it) => this.playlistFromDiss(it)).filter((p) => p && p.name) };
  }

  async charts() {
    return { charts: QQ_RANKS.map((r) => ({ id: r.id, name: r.name, updateMeta: '', coverUrl: '' })) };
  }

  async chartDetail({ id }) {
    const q = formEncode({
      topid: id, format: 'json', inCharset: 'utf8', outCharset: 'utf-8', notice: 0,
      platform: 'yqq.json', needNewCode: 0, tpl: 3, page: 'detail', type: 'top',
      song_begin: 0, song_num: 50,
    });
    const json = await this.getJson('https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?' + q);
    const info = json.topinfo || {};
    const list = json.songlist || [];
    return {
      meta: {
        id: String(id),
        name: String(info.topTitle || info.ListName || ''),
        trackCount: list.length,
        description: String(info.topTitle ? info.commitTime || '' : ''),
        coverUrl: String(info.frontPicUrl || info.headPicUrl || ''),
      },
      songs: list.map((it) => this.song(it.data || it)).filter((s) => s && s.title),
    };
  }

  async lyrics({ id }) {
    const payload = {
      comm: { ct: 24, cv: 0 },
      lyric: {
        module: 'music.musichallSong.PlayLyricInfo',
        method: 'GetPlayLyricInfo',
        param: { songMID: id, songID: 0 },
      },
    };
    const json = await this.postJsonMusicu(payload);
    const data = json.lyric && json.lyric.data;
    if (!data) return { lines: [] };
    let lrc = String(data.lyric || '');
    let trans = String(data.trans || '');
    if (looksBase64(lrc)) lrc = Convert.decodeUtf8(Convert.decodeBase64(lrc));
    if (looksBase64(trans)) trans = Convert.decodeUtf8(Convert.decodeBase64(trans));
    return { lrc: stripHtml(lrc), translation: stripHtml(trans) };
  }

  async songUrl({ id, mediaId, quality }) {
    const songmid = String(id || '').trim();
    if (!songmid) return { url: null };
    const media = String(mediaId || '').trim() || songmid;
    const guid = String(10000000 + Date.now() % 90000000);
    const levelOrder = { standard: 3, exhigh: 2, lossless: 1, hires: 0 };
    const start = levelOrder[quality] !== undefined ? levelOrder[quality] : 2;
    const templates = QQ_TEMPLATES.slice(start);
    const filenames = templates.map((t) => t.prefix + media + t.ext);
    const payload = {
      comm: { uin: '0', format: 'json', ct: 24, cv: 0 },
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid: guid,
          songmid: filenames.map(() => songmid),
          songtype: filenames.map(() => 0),
          uin: '0', loginflag: 1, platform: '20',
          filename: filenames,
        },
      },
    };
    const json = await this.postJsonMusicu(payload, { uin: '0', format: 'json', ct: 24, cv: 0 });
    const data = json.req_0 && json.req_0.data;
    if (!data) return { url: null };
    const sip = (data.sip || []).find((s) => s) || 'https://ws.stream.qqmusic.qq.com/';
    const infos = data.midurlinfo || [];
    for (const info of infos) {
      const purl = String((info && info.purl) || '');
      if (purl) return { url: sip + purl };
    }
    return { url: null };
  }

  /// musicu POST：sign 挂在 URL 上；comm 用 payload 里的（songUrl 用简化版）。
  async postJsonMusicu(payload) {
    const body = JSON.stringify(payload);
    return fetchJson('POST', QQ_MUSICU + '?sign=' + qqSign(body), this.formHeaders, body);
  }

  // ── 映射 ────────────────────────────────────────────────────────────────

  song(it) {
    if (!it) return null;
    const singers = (it.singer || []).map((s) => String(s.name || '')).filter(Boolean);
    const album = it.album || {};
    const file = it.file || {};
    return {
      id: String(it.mid || it.songmid || it.id || ''),
      title: stripHtml(it.name || it.songname),
      artist: singers.length ? singers.join(' / ') : stripHtml(it.singer),
      album: stripHtml(album.name || it.albumname),
      durationMs: Number(it.interval || 0) * 1000,
      mediaId: String(file.media_mid || it.media_mid || ''),
      coverUrl: album.mid ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000' + album.mid + '.jpg' : '',
    };
  }

  playlistFromDiss(it) {
    if (!it) return null;
    return {
      id: String(it.dissid || ''),
      name: String(it.dissname || ''),
      trackCount: 0,
      playCountValue: Number(it.listennum || 0),
      description: String(it.creator && it.creator.nickname || ''),
      coverUrl: String(it.imgurl || ''),
    };
  }
}
