// Respostas simuladas do endpoint de syndication do X, no formato real.

export const VIDEO_TWEET = {
  __typename: 'Tweet',
  id_str: '1790000000000000001',
  text: 'Olha esse gol https://t.co/abc123',
  created_at: '2026-11-20T12:00:00.000Z',
  user: {
    name: 'Fulano de Tal',
    screen_name: 'fulano',
    profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a_normal.jpg',
  },
  mediaDetails: [
    {
      type: 'video',
      media_url_https: 'https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg',
      original_info: { width: 1920, height: 1080 },
      video_info: {
        aspect_ratio: [16, 9],
        duration_millis: 42000,
        variants: [
          { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext_tw_video/1/pu/pl/a.m3u8' },
          { bitrate: 256000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/480x270/a.mp4?tag=12' },
          { bitrate: 2176000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1280x720/b.mp4?tag=12' },
          { bitrate: 10368000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/1920x1080/c.mp4?tag=12' },
          { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/640x360/d.mp4?tag=12' },
        ],
      },
    },
    { type: 'photo', media_url_https: 'https://pbs.twimg.com/media/x.jpg' },
  ],
};

export const GIF_TWEET = {
  __typename: 'Tweet',
  id_str: '1790000000000000002',
  text: 'kkkkk',
  user: { name: 'Ciclana', screen_name: 'ciclana', profile_image_url_https: 'https://pbs.twimg.com/profile_images/2/b_normal.jpg' },
  mediaDetails: [
    {
      type: 'animated_gif',
      media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/XYZ.jpg',
      original_info: { width: 640, height: 360 },
      video_info: {
        aspect_ratio: [16, 9],
        variants: [{ bitrate: 0, content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/XYZ.mp4' }],
      },
    },
  ],
};

export const PRIVATE_TOMBSTONE = {
  __typename: 'TweetTombstone',
  tombstone: {
    text: {
      text: 'You’re unable to view this Post because this account owner limits who can view their Posts. Learn more',
    },
  },
};

export const AGE_TOMBSTONE = {
  __typename: 'TweetTombstone',
  tombstone: { text: { text: 'Age-restricted adult content. This content might not be appropriate for people under 18 years old.' } },
};

export const PHOTO_TWEET = {
  __typename: 'Tweet',
  id_str: '1790000000000000005',
  text: 'foto',
  user: { name: 'A', screen_name: 'a' },
  mediaDetails: [{ type: 'photo', media_url_https: 'https://pbs.twimg.com/media/y.jpg' }],
};

export const QUOTE_TWEET = {
  __typename: 'Tweet',
  id_str: '1790000000000000006',
  text: 'vejam isso',
  user: { name: 'B', screen_name: 'b' },
  quoted_tweet: { mediaDetails: VIDEO_TWEET.mediaDetails },
};
