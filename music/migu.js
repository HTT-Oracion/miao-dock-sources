/*
 * 咪咕音乐 JS 源。
 *
 * · 搜索 / 榜单 / 歌单免登录；播放地址走 listen 端点
 * · 🔴 listen 返回的是**混淆字节流**：`out[i] = body[i+4] + offset - key[i % key.len]`
 *   （offset 取响应第 4 字节，key 固定 31 字节）—— Network.fetchBytes 拿字节后
 *   本地解码，漏掉 +offset 整段正文错位成乱码
 * · 歌曲双 id：copyrightId（song.id）与 contentId（song.mediaId），
 *   listen 同时要两个 —— 与内置实现的参数流一致
 */
const MIGU_LISTEN = 'https://app.c.nf.migu.cn/strategy/pc/listen/v2.0';
const MIGU_SONG_SEARCH = 'https://app.u.nf.migu.cn/pc/resource/song/item/search/v1.0';
const MIGU_RANK_SONGS = 'https://app.c.nf.migu.cn/MIGUM3.0/column/rank/h5/v1.0';
const MIGU_PLAYLIST_DETAIL = 'https://app.c.nf.migu.cn/resource/playlist/v2.0';
const MIGU_PLAYLIST_SONGS = 'https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0';
const MIGU_LISTEN_KEY = 'Jk8qzuePiJ1qE3mDYhLQ3T73DtDoAhLP';

const MIGU_RANKS = [
  { id: '27186466', name: '热歌榜' },
  { id: '27553319', name: '新歌榜' },
  { id: '27553408', name: '原创榜' },
];

const AUDIO_EXT = /\.(mp3|flac|m4a|wav|aac|ogg)(\?|$)/i;

function padImage(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v.startsWith('//')) return 'https:' + v;
  if (v.startsWith('http')) return v.replace('http://', 'https://');
  return 'https://d.musicapp.migu.cn' + (v.startsWith('/') ? '' : '/') + v;
}

function decodeListenBody(bytes) {
  if (bytes.length <= 4) return {};
  const offset = bytes[3];
  const key = Convert.encodeUtf8(MIGU_LISTEN_KEY);
  const out = [];
  for (let i = 0; i < bytes.length - 4; i++) {
    out.push((bytes[i + 4] + offset - key[i % key.length]) & 0xFF);
  }
  return JSON.parse(Convert.decodeUtf8(out));
}

/// 深度找第一个匹配的字符串 URL（音频 / 歌词共用同一步进）。
function findUrl(json, predicate) {
  let found = null;
  function walk(node) {
    if (found !== null) return;
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const v of Object.values(node)) {
        if (typeof v === 'string' && predicate(v)) {
          found = v;
          return;
        }
        walk(v);
      }
    } else if (Array.isArray(node)) {
      for (const v of node) walk(v);
    }
  }
  walk(json);
  return found;
}

class MiguSource extends MusicSourceBase {
  name = '咪咕';
  platform = 'migu';
  key = 'migu';
  version = '1.0.0';
  baseUrl = 'https://app.c.nf.migu.cn';

  async searchSongs({ keyword, limit = 30, offset = 0 }) {
    const pageSize = Math.max(1, Math.min(limit, 50));
    const page = Math.floor(offset / pageSize) + 1;
    const json = await this.getJson(MIGU_SONG_SEARCH + '?' + formEncode({ text: keyword, pageNo: page, pageSize: pageSize }));
    const list = Array.isArray(json) ? json : [];
    return { songs: list.map((it) => this.song(it)).filter((s) => s && s.title) };
  }

  async charts() {
    return { charts: MIGU_RANKS.map((r) => ({ id: r.id, name: r.name, updateMeta: '', coverUrl: '' })) };
  }

  async chartDetail({ id }) {
    return this.rankSongs(id);
  }

  async rankSongs(columnId) {
    const json = await this.getJson(MIGU_RANK_SONGS + '?' + formEncode({ pageSize: 50, columnId: columnId }));
    const contents = json.data && json.data.columnInfo && json.data.columnInfo.contents || [];
    const songs = contents
      .filter((it) => it && it.objectInfo)
      .map((it) => this.song(it.objectInfo))
      .filter((s) => s && s.title);
    const title = json.data && json.data.columnInfo && json.data.columnInfo.columnName || '';
    return {
      meta: { id: String(columnId), name: String(title), trackCount: songs.length },
      songs: songs,
    };
  }

  async playlistDetail({ id }) {
    const metaJson = await this.getJson(MIGU_PLAYLIST_DETAIL + '?' + formEncode({ playlistId: id }));
    const info = metaJson.data && metaJson.data.playlist && metaJson.data.playlist[0] || {};
    const songsJson = await this.getJson(MIGU_PLAYLIST_SONGS + '?' + formEncode({
      playlistId: id, pageNo: 1, pageSize: 50, type: 2,
    }));
    const contents = songsJson.data && songsJson.data.tracks && songsJson.data.tracks.list || [];
    const songs = contents
      .map((it) => this.song(it.song || it.objectInfo || it))
      .filter((s) => s && s.title);
    return {
      meta: {
        id: String(id),
        name: String(info.name || info.title || ''),
        trackCount: Number(info.totalCount || songs.length || 0),
        description: String(info.summary || info.desc || ''),
        coverUrl: padImage(info.img || info.image || info.cover),
      },
      songs: songs,
    };
  }

  async listen({ contentId, copyrightId, quality }) {
    const toneFlag = { standard: 'PQ', high: 'HQ', lossless: 'SQ' }[quality] || 'ZQ';
    const res = await Network.fetchBytes('GET', MIGU_LISTEN + '?' + formEncode({
      contentId: contentId, copyrightId: copyrightId, scene: '',
      netType: '01', resourceType: 2, toneFlag: toneFlag,
    }));
    if (res.status < 200 || res.status >= 300) {
      throw sourceError('NETWORK', 'HTTP ' + res.status);
    }
    const bytes = Convert.decodeBase64(res.bodyBase64);
    return decodeListenBody(bytes);
  }

  async songUrl({ id, mediaId, quality }) {
    // 与内置实现同口径：逐档降级；http 播放地址强制换 https。
    const order = quality === 'standard' ? ['standard']
      : quality === 'high' ? ['high', 'standard']
      : ['lossless', 'high', 'standard'];
    const contentId = String(mediaId || id);
    const copyrightId = String(id || '');
    for (const q of order) {
      try {
        const json = await this.listen({ contentId: contentId, copyrightId: copyrightId, quality: q });
        const url = findUrl(json, (v) => (v.startsWith('http://') || v.startsWith('https://')) && AUDIO_EXT.test(v));
        if (url) return { url: url.replace('http://', 'https://') };
      } catch (e) {
        // 单档失败继续降级。
      }
    }
    return { url: null };
  }

  async lyrics({ id, mediaId }) {
    const json = await this.listen({ contentId: String(mediaId || id), copyrightId: String(id), quality: 'standard' });
    const lrcUrl = findUrl(json, (v) => v.indexOf('lrc') >= 0 && v.startsWith('http'));
    if (!lrcUrl) return { lines: [] };
    const res = await Network.sendRequest('GET', lrcUrl);
    if (res.status < 200 || res.status >= 300) return { lines: [] };
    return { lrc: res.body };
  }

  // ── 映射 ────────────────────────────────────────────────────────────────

  song(it) {
    if (!it) return null;
    const singers = (it.singerList || []).map((s) => String(s.name || '')).filter(Boolean);
    // 🔴 咪咕 duration 是**秒**（其它平台多为毫秒）：直接乘 1000。
    return {
      id: String(it.copyrightId || it.songId || it.contentId || ''),
      title: String(it.songName || it.name || ''),
      artist: singers.length ? singers.join(' / ') : String(it.singerName || ''),
      album: String(it.album || it.albumName || ''),
      durationMs: Number(it.duration || 0) * 1000,
      mediaId: String(it.contentId || it.copyrightId || ''),
      coverUrl: padImage(it.cover || it.img || it.image),
    };
  }
}
