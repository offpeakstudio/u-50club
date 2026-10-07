const fs = require('fs');
const path = require('path');

const API_KEY = process.env.YOUTUBE_API_KEY;
if (!API_KEY) {
  console.error("Error: YOUTUBE_API_KEY is not set.");
  process.exit(1);
}

// 日時計算: 「1ヶ月前〜1年前」の中から、ランダムな30日間のウィンドウ（範囲）を動的に計算
const now = new Date();
const totalDays = 305; // 365 - 30 -30
const randomOffsetDays = Math.floor(Math.random() * totalDays);

// 検索終了日を「1ヶ月前〜11ヶ月前」のどこかにランダム設定
const publishedBeforeDate = new Date(now.getTime() - (30 + randomOffsetDays) * 24 * 60 * 60 * 1000);
// そこからさらに30日前を検索開始日に設定
const publishedAfterDate = new Date(publishedBeforeDate.getTime() - 30 * 24 * 60 * 60 * 1000);

const publishedAfter = publishedAfterDate.toISOString();
const publishedBefore = publishedBeforeDate.toISOString();

console.log(`Searching date range: ${publishedAfter.split('T')[0]} to ${publishedBefore.split('T')[0]}`);

// スコア計算ロジック
function calculateScore(video, channel) {
  let score = 0;

  const title = video.snippet?.title || "";
  const description = video.snippet?.description || "";
  const defaultLanguage = video.snippet?.defaultLanguage || "";
  const channelTitle = video.snippet?.channelTitle || "";
  const channelCountry = channel?.snippet?.country || "";
  const channelDesc = channel?.snippet?.description || "";

  // 1. 加点要素
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(title)) score += 3;
  if (/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(description)) score += 2;
  if (channelCountry === 'JP' || /日本|Japan/i.test(channelDesc)) score += 3;
  if (defaultLanguage.startsWith('ja')) score += 2;
  score += 2; // regionCode=JPによる検索基本点

  // 2. 減点キーワード（タイトル・概要欄）
  const text = (title + " " + description).toLowerCase();

  const penalty5 = ['cover', 'カバー', '歌ってみた', '弾いてみた', 'asmr'];
  const penalty3 = ['karaoke', 'カラオケ', 'reaction', 'リアクション'];

  penalty5.forEach(kw => { if (text.includes(kw)) score -= 5; });
  penalty3.forEach(kw => { if (text.includes(kw)) score -= 3; });
/*
  // 3. 配信サービス系自動生成チャンネル（Topic / トピック）の優先度を下げる（-1）
  const channelTitleLower = channelTitle.toLowerCase();
  if (channelTitleLower.includes('topic') || channelTitle.includes('トピック')) {
    score -= 1;
  }
*/
  return score;
}

// ISO 8601形式の時間を秒数に変換（undefined対策を追加）
function parseDuration(durationStr) {
  if (!durationStr || typeof durationStr !== 'string') return 0;
  const match = durationStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || 0, 10);
  const minutes = parseInt(match[2] || 0, 10);
  const seconds = parseInt(match[3] || 0, 10);
  return hours * 3600 + minutes * 60 + seconds;
}

// 配列を指定サイズごとに分割するヘルパー
function chunkArray(array, chunkSize) {
  const results = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    results.push(array.slice(i, i + chunkSize));
  }
  return results;
}

async function main() {
  try {
    console.log("Fetching low-view music videos from YouTube API...");

    // 1. 音楽カテゴリ (10) の動画を複数ページ取得（最大10ページ = 500件）
    let allSearchItems = [];
    let nextPageToken = '';
    const maxPages = 10;

    for (let page = 0; page < maxPages; page++) {
      const pageParam = nextPageToken ? `&pageToken=${nextPageToken}` : '';
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=id,snippet&type=video&videoCategoryId=10&regionCode=JP&relevanceLanguage=ja&publishedAfter=${publishedAfter}&publishedBefore=${publishedBefore}&order=date&maxResults=50${pageParam}&key=${API_KEY}`;

      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();

      if (searchData.items && searchData.items.length > 0) {
        allSearchItems = allSearchItems.concat(searchData.items);
      }

      nextPageToken = searchData.nextPageToken;
      if (!nextPageToken) break;
    }

    if (allSearchItems.length === 0) {
      console.log("No videos found in search range.");
      return;
    }

    const videoIds = allSearchItems.map(item => item.id?.videoId).filter(Boolean);
    console.log(`Total searched video IDs: ${videoIds.length}`);

    // 2. 50件ずつ分割して動画詳細を取得
    const idChunks = chunkArray(videoIds, 50);
    let allVideoItems = [];

    for (const chunk of idChunks) {
      const videosUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${chunk.join(',')}&key=${API_KEY}`;
      const videosRes = await fetch(videosUrl);
      const videosData = await videosRes.json();
      if (videosData.items) {
        allVideoItems = allVideoItems.concat(videosData.items);
      }
    }

    // 3. チャンネル情報を取得（50件ずつ分割）
    const channelIds = [...new Set(allVideoItems.map(item => item.snippet?.channelId).filter(Boolean))];
    const channelChunks = chunkArray(channelIds, 50);
    const channelMap = {};

    for (const chunk of channelChunks) {
      const channelsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${chunk.join(',')}&key=${API_KEY}`;
      const channelsRes = await fetch(channelsUrl);
      const channelsData = await channelsRes.json();
      (channelsData.items || []).forEach(ch => {
        channelMap[ch.id] = ch;
      });
    }

    // 4. フィルタリングとスコアリング
    const qualifiedVideos = [];

    for (const item of allVideoItems) {
      const views = parseInt(item.statistics?.viewCount || '0', 10);
      const durationSec = parseDuration(item.contentDetails?.duration);
      const channel = channelMap[item.snippet?.channelId];
      const score = calculateScore(item, channel);

      // 条件: 再生数 <= 50 ＆ 長さ 1分〜10分 ＆ スコア >= 3
      if (views <= 50 && durationSec >= 60 && durationSec <= 600 && score >= 3) {
        qualifiedVideos.push({
          id: item.id,
          title: item.snippet?.title,
          channelTitle: item.snippet?.channelTitle,
          views: views,
          score: score,
          publishedAt: item.snippet?.publishedAt ? item.snippet.publishedAt.split('T')[0] : ''
        });
      }
    }

    console.log(`Matched videos passing criteria: ${qualifiedVideos.length}`);

    // ランダムに並び替えて先頭5件を抽出
    const shuffled = qualifiedVideos.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, 5);

    if (selected.length === 0) {
      console.log("No videos passed the filter today. Keeping existing data.");
      return;
    }

    const outputData = {
      updatedAt: new Date().toISOString().split('T')[0],
      videos: selected
    };

    // data/daily.json に書き出し
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(path.join(dataDir, 'daily.json'), JSON.stringify(outputData, null, 2));
    console.log(`Successfully generated daily.json with ${selected.length} videos!`);

  } catch (error) {
    console.error("Error executing fetch script:", error);
    process.exit(1);
  }
}

main();
