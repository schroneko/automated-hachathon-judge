const reviewedAssets: Readonly<Record<string, readonly string[]>> = {
  "my-name-is-yu/devdaycommunity26@c8450be00007853ca08efdd09c58c8e0504d7c83": [
    "apps/city-light/data/buildings.json",
    "apps/city-light/data/pois.json",
    "apps/city-light/data/geography.json",
    "apps/city-light/data/evaluations.json",
    "apps/city-light/data/unassigned.json",
    "apps/city-light/data/open-data/crime-2025.json",
    "apps/city-light/data/open-data/crime-2025.csv",
    "apps/city-light/data/open-data/towns-13103.topojson",
    "apps/city-light/data/open-data/towns-13110.topojson",
    "apps/city-light/data/open-data/towns-13113.topojson",
    "apps/city-light/public/data/map.json",
    "apps/city-light/public/data/area-context.json"
  ],
  "eightman999/devday-community-hackathon@1a458327b7208bdaaabb2cd4d52ca4da7821e43d": [
    "presentation/index.html"
  ],
  "sanamiy/dots-towerbattle@d0887b8f37431cc95a7d8a4ddbd5cc78eab67347": [
    "site/assets/alfred-poses/colliders.json",
    "site/assets/todd-poses/colliders.json",
    "site/assets/iggy-poses/colliders.json",
    "site/lib/game/alfred-poses.json",
    "site/lib/game/todd-poses.json",
    "site/lib/game/iggy-poses.json",
    "site/lib/game/felipe-poses.json",
    "site/lib/game/official-outlines.json"
  ],
  "ahwenu/scavenger-hunt@bbf40cd4a0f819abcea225897ff0506a337173c1": [
    "apps/cloud/lib/assets.ts"
  ]
};

export function isReviewedAsset(repo: string, pinnedSha: string, path: string): boolean {
  return reviewedAssets[`${repo.toLowerCase()}@${pinnedSha}`]?.includes(path) ?? false;
}
