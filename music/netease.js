/*
 * 网易云音乐 JS 源（第一步样例）。
 *
 * 能力：searchSongs / searchPlaylists / charts / chartDetail / playlistDetail /
 * lyrics / songUrl / comments / userPlaylists。登录态由 App 把 WebView Cookie
 * 注入源的 Cookie 罐（engine.setSessionCookie），userPlaylists 依赖它。
 *
 * 字段映射与内置 Dart 版一致（ar/artists、al/album、dt/duration 双兼容）。
 */
class NeteaseSource extends MusicSourceBase {
  name = '网易云';
  platform = 'netease';
  key = 'netease';
  version = '1.0.0';
  baseUrl = 'https://music.163.com';

  // 播放流 Referer（网易云 CDN 防盗链）。
  referer = 'https://music.163.com/';

  // WebView 登录声明（App 据此打开官方登录页并回读 Cookie）。
  loginUrl = 'https://music.163.com/#/login';
  loginCookieDomains = '163.com,netease.com';
  loginCookieNames = 'MUSIC_U';

  async searchSongs({ keyword, limit = 30, offset = 0 }) {
    const json = await this.postForm('/api/search/get/web', { s: keyword, type: 1, limit: limit, offset: offset });
    return { songs: this.songs(json.result && json.result.songs) };
  }

  async searchPlaylists({ keyword, limit = 12, offset = 0 }) {
    const json = await this.postForm('/api/search/get/web', { s: keyword, type: 1000, limit: limit, offset: offset });
    return { playlists: this.playlists(json.result && json.result.playlists) };
  }

  async charts() {
    const json = await this.postForm('/api/toplist/detail', {});
    const list = json.list || [];
    return {
      charts: list.map((it) => ({
        id: String(it.id || ''),
        name: String(it.name || ''),
        updateMeta: String(it.updateFrequency || it.updateTime || ''),
        coverUrl: String(it.coverImgUrl || ''),
      })),
    };
  }

  async chartDetail({ id }) {
    return this.playlistDetail({ id: id });
  }

  async playlistDetail({ id }) {
    const json = await this.postForm('/api/v6/playlist/detail', { id: id, n: 1000, s: 0 });
    const pl = json.playlist || {};
    const meta = {
      id: String(pl.id || id),
      name: String(pl.name || ''),
      trackCount: Number(pl.trackCount || 0),
      description: String(pl.description || ''),
      coverUrl: String(pl.coverImgUrl || ''),
    };
    return { meta: meta, songs: this.songs(pl.tracks) };
  }

  async lyrics({ id }) {
    const json = await this.postForm('/api/song/lyric/v1', {
      id: id, cp: 'false', lv: 0, kv: 0, tv: 0, rv: 0, yv: 0, ytv: 0, yrv: 0, csrf_token: '',
    });
    return { lrc: (json.lrc && json.lrc.lyric) || '', translation: (json.tlyric && json.tlyric.lyric) || '' };
  }

  async songUrl({ id, quality }) {
    for (const level of this.levelsFor(quality)) {
      const json = await this.postForm('/api/song/enhance/player/url/v1', {
        ids: JSON.stringify([id]), level: level, encodeType: 'flac', csrf_token: '',
      });
      const first = json.data && json.data[0];
      const url = first && first.url;
      if (url && String(url).length > 0) return { url: String(url) };
    }
    return { url: null };
  }

  async comments({ songId, limit = 20, offset = 0 }) {
    const json = await this.getJson('/api/v1/resource/comments/R_SO_4_' + songId + '?limit=' + limit + '&offset=' + offset);
    const hot = json.hotComments || [];
    const all = json.comments || [];
    const map = (c) => ({
      id: String(c.commentId || ''),
      nick: String((c.user && c.user.nickname) || ''),
      content: String(c.content || ''),
      time: String(c.timeStr || ''),
      likes: Number(c.likedCount || 0),
      hot: false,
    });
    return { comments: hot.map(map).concat(all.map(map)) };
  }

  /// 账户信息（App 登录后回读昵称 / 校验 Cookie 有效性）。
  /// 🔴 对齐 miao-dock：用 GET `/api/w/nuser/account/get`（带 Cookie）；
  /// profile 兜底链 data.profile → body.profile → account.profile。
  async loginInfo() {
    const json = await this.getJson('/api/w/nuser/account/get');
    const data = json.data || json;
    const profile = data.profile || json.profile || (data.account && data.account.profile) || (json.account && json.account.profile) || null;
    if (!profile) return { loggedIn: false, nick: '', avatarUrl: '' };
    // userId 必须存在才算登录（参考 normalizeLoginInfo）。
    const uid = String(profile.userId || profile.user_id || profile.id || '');
    return {
      loggedIn: uid.length > 0,
      nick: String(profile.nickname || ''),
      avatarUrl: this.picUrl(profile.avatarUrl),
    };
  }

  /// 每日推荐（内置 Dart 口径：personalized/newsong 匿名可取，song.al 缺图用外层 picUrl）。
  async dailySongs() {
    const json = await this.getJson('/api/personalized/newsong?limit=6');
    const list = json.result || [];
    const songs = [];
    for (const item of list) {
      const inner = item.song || item;
      const song = this.song(inner);
      if (!song || !song.title) continue;
      // 外层 picUrl 常是推荐位封面，内层 al 往往缺图 —— 补到歌上。
      if (!song.coverUrl) song.coverUrl = this.picUrl(item.picUrl);
      songs.push(song);
    }
    return { songs: songs };
  }

  /// 相似歌曲（心动模式驱动）：登录态走智能播放，失败回退匿名 simSong。
  async similarSongs({ id }) {
    if (this.loggedInCache) {
      try {
        const liked = (await this.userPlaylists()).playlists.find((p) => p.special);
        if (liked) {
          const json = await this.postForm('/api/playmode/intelligence/list', {
            songId: id, type: 'fromPlayOne', playlistId: liked.id, startMusicId: id, count: 1,
          });
          const rows = json.data || [];
          const songs = rows
            .filter((it) => it && it.songInfo)
            .map((it) => this.song(it.songInfo))
            .filter((s) => s && s.title);
          if (songs.length) return { songs: songs.slice(0, 20) };
        }
      } catch (e) {
        // 智能播放要求登录与喜欢歌单；失败继续走匿名接口。
      }
    }
    const json = await this.getJson('/api/v1/discovery/simiSong?' + formEncode({ songid: id }));
    return { songs: (json.songs || []).map((it) => this.song(it)).filter((s) => s && s.title) };
  }

  /// 发现页「推荐歌单」卡（匿名可取）。
  async recommendedPlaylists({ limit = 6 }) {
    const json = await this.postForm('/api/personalized/playlist', { limit: limit, csrf_token: '' });
    return { playlists: this.playlists(json.result || []) };
  }

  async userPlaylists() {
    const uid = await this.currentUid();
    if (!uid) return { playlists: [] };
    const json = await this.postForm('/api/user/playlist', { uid: uid, limit: 30, offset: 0, includeVideo: true });
    return { playlists: this.playlists(json.playlist) };
  }

  async currentUid() {
    // 登录态来自 App 注入的 Cookie：MUSIC_U 存在时账号接口回 userId。
    const cookies = await Network.getCookies(this.baseUrl + '/');
    const names = Object.keys(cookies || {});
    if (names.indexOf('MUSIC_U') < 0) return null;
    const json = await this.postForm('/api/nuser/account/get', {});
    const uid = json.profile && json.profile.userId;
    return uid ? Number(uid) : null;
  }

  // ── 字段映射（与内置 Dart 版一致） ─────────────────────────────────────

  /// 网易云封面统一 https + 300×300 缩放参数。
  /// 🔴 http 直连会 403（播放器 artUri 走系统缓存管理器，无自定义头）。
  picUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    const base = v.replace('http://', 'https://');
    return base.indexOf('?') >= 0 ? base : base + '?param=300y300';
  }

  songs(list) {
    return (list || []).map((it) => this.song(it)).filter((s) => s && s.title);
  }

  song(it) {
    if (!it) return null;
    const artists = (it.ar || it.artists || []).map((a) => String(a.name || '')).filter(Boolean);
    const album = it.al || it.album || {};
    return {
      id: String(it.id || ''),
      title: String(it.name || ''),
      artist: artists.length ? artists.join(' / ') : String(it.artist || ''),
      album: String(album.name || ''),
      durationMs: Number(it.dt || it.duration || 0),
      coverUrl: this.picUrl(album.picUrl),
    };
  }

  playlists(list) {
    return (list || []).map((it) => this.playlist(it)).filter((p) => p && p.name);
  }

  playlist(it) {
    if (!it) return null;
    const creator = it.creator;
    const nick = creator && creator.nickname ? String(creator.nickname) : String(it.copywriter || '');
    return {
      id: String(it.id || ''),
      name: String(it.name || ''),
      trackCount: Number(it.trackCount || it.songCount || 0),
      playCountValue: Number(it.playCount || it.playcount || 0),
      description: nick,
      coverUrl: this.picUrl(it.coverImgUrl || it.picUrl),
      author: nick || undefined,
      // 🔴 specialType=5 是【我喜欢的音乐】：歌单库用它做置顶横卡（groupPlaylists）。
      special: Number(it.specialType || 0) === 5,
      subscribed: it.subscribed === true,
    };
  }
}
