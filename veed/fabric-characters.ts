// The Fabric character presets, copied verbatim from VEED's own Fabric integration. There is NO API
// that serves this list — listing characters there is a pure filter over the same hardcoded array,
// so vendoring it is the whole of what that listing does. Re-copy if VEED adds characters.
//
// This is a DEFAULT MENU, not a limit: Fabric One Lipsync takes any image asset, so
// veed/fabric.ts also accepts --image <url|path>. Each preset carries a voiceId that pairs
// well with the face; it is the default when --voice is not given.
//
// Thumbnails and previews are public on cdn-site-assets.veed.io — no auth, and the transload
// route fetches the thumbnail server-side, so these bytes never pass through this process.
export interface Character {
  id: string;
  name: string;
  thumbnail: string;
  gender: 'male' | 'female';
  voiceId: string;
  previewUrl: string;
}

// `readonly` rather than upstream's `Character[]`: the literal ends in a const assertion, which is
// not assignable to a mutable array type.
export const FABRIC_CHARACTERS: readonly Character[] = [
  {
    id: 'character-1',
    name: 'Character 1',
    thumbnail:
      'https://cdn-site-assets.veed.io/1_P_bd7b69e369/1_P_bd7b69e369.jpg',
    gender: 'female',
    voiceId: 'jqcCZkN6Knx8BJ5TBdYR',
    previewUrl: 'https://cdn-site-assets.veed.io/1_b90bca51f4/1_b90bca51f4.mp4',
  },
  {
    id: 'character-2',
    name: 'Character 2',
    thumbnail: 'https://cdn-site-assets.veed.io/2_bdeae28943/2_bdeae28943.jpg',
    gender: 'female',
    voiceId: 'wkqe33083YLBV35we7yB',
    previewUrl: 'https://cdn-site-assets.veed.io/2_7b367257e0/2_7b367257e0.mp4',
  },
  {
    id: 'character-3',
    name: 'Character 3',
    thumbnail: 'https://cdn-site-assets.veed.io/3_094c5d0d71/3_094c5d0d71.jpg',
    gender: 'male',
    voiceId: '2mltbVQP21Fq8XgIfRQJ',
    previewUrl: 'https://cdn-site-assets.veed.io/3_33eaad1791/3_33eaad1791.mp4',
  },
  {
    id: 'character-4',
    name: 'Character 4',
    thumbnail: 'https://cdn-site-assets.veed.io/4_1c2e9b9449/4_1c2e9b9449.jpg',
    gender: 'female',
    voiceId: '4tRn1lSkEn13EVTuqb0g',
    previewUrl: 'https://cdn-site-assets.veed.io/4_a2c23964d3/4_a2c23964d3.mp4',
  },
  {
    id: 'character-5',
    name: 'Character 5',
    thumbnail: 'https://cdn-site-assets.veed.io/5_571a53eb5e/5_571a53eb5e.jpg',
    gender: 'female',
    voiceId: 'T7eLpgAAhoXHlrNajG8v',
    previewUrl: 'https://cdn-site-assets.veed.io/5_ed9e3f064b/5_ed9e3f064b.mp4',
  },
  {
    id: 'character-6',
    name: 'Character 6',
    thumbnail:
      'https://cdn-site-assets.veed.io/6_P_c69c4ddae8/6_P_c69c4ddae8.jpg',
    gender: 'male',
    voiceId: '1BUhH8aaMvGMUdGAmWVM',
    previewUrl: 'https://cdn-site-assets.veed.io/6_4de04ca6c4/6_4de04ca6c4.mp4',
  },
  {
    id: 'character-7',
    name: 'Character 7',
    thumbnail: 'https://cdn-site-assets.veed.io/7_4070f310cb/7_4070f310cb.jpg',
    gender: 'female',
    voiceId: 'SAz9YHcvj6GT2YYXdXww',
    previewUrl: 'https://cdn-site-assets.veed.io/7_a2d3132e04/7_a2d3132e04.mp4',
  },
  {
    id: 'character-8',
    name: 'Character 8',
    thumbnail: 'https://cdn-site-assets.veed.io/8_dce399ffd9/8_dce399ffd9.jpg',
    gender: 'female',
    voiceId: 'jqcCZkN6Knx8BJ5TBdYR',
    previewUrl: 'https://cdn-site-assets.veed.io/8_995be9659f/8_995be9659f.mp4',
  },
  {
    id: 'character-9',
    name: 'Character 9',
    thumbnail: 'https://cdn-site-assets.veed.io/9_e1269440e8/9_e1269440e8.jpg',
    gender: 'male',
    voiceId: 'gs0tAILXbY5DNrJrsM6F',
    previewUrl: 'https://cdn-site-assets.veed.io/9_cdae080aa7/9_cdae080aa7.mp4',
  },
  {
    id: 'character-10',
    name: 'Character 10',
    thumbnail:
      'https://cdn-site-assets.veed.io/10_c51ad7b85f/10_c51ad7b85f.jpg',
    gender: 'female',
    voiceId: 'FVQMzxJGPUBtfz1Azdoy',
    previewUrl:
      'https://cdn-site-assets.veed.io/10_a5ed3c4649/10_a5ed3c4649.mp4',
  },
  {
    id: 'character-11',
    name: 'Character 11',
    thumbnail:
      'https://cdn-site-assets.veed.io/11_P_f99954fcfe/11_P_f99954fcfe.jpg',
    gender: 'male',
    voiceId: 'pwMBn0SsmN1220Aorv15',
    previewUrl:
      'https://cdn-site-assets.veed.io/11_c42cbb7bff/11_c42cbb7bff.mp4',
  },
  {
    id: 'character-12',
    name: 'Character 12',
    thumbnail:
      'https://cdn-site-assets.veed.io/12_0bf54bcd62/12_0bf54bcd62.jpg',
    gender: 'female',
    voiceId: '6u6JbqKdaQy89ENzLSju',
    previewUrl:
      'https://cdn-site-assets.veed.io/12_c73d0fa99b/12_c73d0fa99b.mp4',
  },
  {
    id: 'character-13',
    name: 'Character 13',
    thumbnail:
      'https://cdn-site-assets.veed.io/13_c0475066b8/13_c0475066b8.jpg',
    gender: 'female',
    voiceId: '8DzKSPdgEQPaK5vKG0Rs',
    previewUrl:
      'https://cdn-site-assets.veed.io/13_f88c128573/13_f88c128573.mp4',
  },
  {
    id: 'character-14',
    name: 'Character 14',
    thumbnail:
      'https://cdn-site-assets.veed.io/14_P_3fa580b86a/14_P_3fa580b86a.jpg',
    gender: 'female',
    voiceId: 'kPzsL2i3teMYv0FxEYQ6',
    previewUrl:
      'https://cdn-site-assets.veed.io/14_2a682c98a4/14_2a682c98a4.mp4',
  },
  {
    id: 'character-15',
    name: 'Character 15',
    thumbnail:
      'https://cdn-site-assets.veed.io/15_P_7d44dcb0df/15_P_7d44dcb0df.jpg',
    gender: 'female',
    voiceId: 'eBvoGh8YGJn1xokno71w',
    previewUrl:
      'https://cdn-site-assets.veed.io/15_01d78f15f4/15_01d78f15f4.mp4',
  },
  {
    id: 'character-16',
    name: 'Character 16',
    thumbnail:
      'https://cdn-site-assets.veed.io/16_674d899465/16_674d899465.jpg',
    gender: 'male',
    voiceId: 'VlUmeC1Uzj3NnwiVR9K9',
    previewUrl:
      'https://cdn-site-assets.veed.io/16_af095aa103/16_af095aa103.mp4',
  },
  {
    id: 'character-17',
    name: 'Character 17',
    thumbnail:
      'https://cdn-site-assets.veed.io/17_P_96b8bf3cb0/17_P_96b8bf3cb0.jpg',
    gender: 'female',
    voiceId: 't7jjqLOG6kzCY6SckkfL',
    previewUrl:
      'https://cdn-site-assets.veed.io/17_bc20f3f07f/17_bc20f3f07f.mp4',
  },
  {
    id: 'character-18',
    name: 'Character 18',
    thumbnail:
      'https://cdn-site-assets.veed.io/18_0bc9ef0ef8/18_0bc9ef0ef8.jpg',
    gender: 'female',
    voiceId: '8DzKSPdgEQPaK5vKG0Rs',
    previewUrl:
      'https://cdn-site-assets.veed.io/18_8a66e0e89a/18_8a66e0e89a.mp4',
  },
  {
    id: 'character-19',
    name: 'Character 19',
    thumbnail:
      'https://cdn-site-assets.veed.io/19_98dae9b182/19_98dae9b182.jpg',
    gender: 'male',
    voiceId: '6OzrBCQf8cjERkYgzSg8',
    previewUrl:
      'https://cdn-site-assets.veed.io/19_0b42d84604/19_0b42d84604.mp4',
  },
  {
    id: 'character-20',
    name: 'Character 20',
    thumbnail:
      'https://cdn-site-assets.veed.io/20_66526d0e4f/20_66526d0e4f.jpg',
    gender: 'female',
    voiceId: 'gPe4h2IS1C7XHbnizzFa',
    previewUrl:
      'https://cdn-site-assets.veed.io/20_fe82034678/20_fe82034678.mp4',
  },
  {
    id: 'character-21',
    name: 'Character 21',
    thumbnail:
      'https://cdn-site-assets.veed.io/21_dd985d182b/21_dd985d182b.png',
    gender: 'female',
    voiceId: 'XfNU2rGpBa01ckF309OY',
    previewUrl:
      'https://cdn-site-assets.veed.io/21_ba3d311d14/21_ba3d311d14.mp4',
  },
  {
    id: 'character-22',
    name: 'Character 22',
    thumbnail:
      'https://cdn-site-assets.veed.io/22_031ba9ca51/22_031ba9ca51.png',
    gender: 'male',
    voiceId: 'VlUmeC1Uzj3NnwiVR9K9',
    previewUrl:
      'https://cdn-site-assets.veed.io/22_886acf57ba/22_886acf57ba.mp4',
  },
  {
    id: 'character-23',
    name: 'Character 23',
    thumbnail:
      'https://cdn-site-assets.veed.io/23_8071c211e4/23_8071c211e4.png',
    gender: 'female',
    voiceId: 'FGY2WhTYpPnrIDTdsKH5',
    previewUrl:
      'https://cdn-site-assets.veed.io/23_04586068b9/23_04586068b9.mp4',
  },
  {
    id: 'character-24',
    name: 'Character 24',
    thumbnail:
      'https://cdn-site-assets.veed.io/24_79dd57fb98/24_79dd57fb98.png',
    gender: 'female',
    voiceId: 'jqcCZkN6Knx8BJ5TBdYR',
    previewUrl:
      'https://cdn-site-assets.veed.io/24_0715d7fbd6/24_0715d7fbd6.mp4',
  },
] as const;
