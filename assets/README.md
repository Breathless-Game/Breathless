# Asset library · fish and equipment

**English** · [简体中文](README.zh-CN.md)

Every fish and the fishing rod in 屏息 Breathless is built in code. The rod uses more detailed hardware and PBR materials while retaining faceted shading. This folder catalogs the assets with renders, model parameters, a reusable Lv1 fishing-net GLB, and 27 archived equipment upgrade display models (30 are defined; the reel is not archived yet). The game builds its models live; the exported files are available for reuse.

---

## Contents

1. [What is in this folder](#1-what-is-in-this-folder)
2. [Fish](#2-fish)
3. [Fishing rod](#3-fishing-rod)
4. [Using the assets](#4-using-the-assets)
5. [Rendering the pictures again](#5-rendering-the-pictures-again)
6. [Adding or changing an asset](#6-adding-or-changing-an-asset)
7. [Equipment upgrade models](#7-equipment-upgrade-models)

---

## 1. What is in this folder

```
assets/
├── README.md            this page
├── README.zh-CN.md      this page in Chinese
├── fish/                17 sprites, one per species: 512 × 512 PNG, transparent
├── gear/                fishing-net renders and the reusable Lv1 GLB
│   ├── fishing-net.png                  1024 × 512 PNG, transparent
│   ├── fishing-net-dark.png             1024 × 512 PNG, on dark water
│   ├── fishing-net-faceted-preview.png  inspection preview
│   └── fishing-net-faceted.glb          base Lv1 model with per-face normals
├── upgrades/            9 equipment classes × 3 tiers: PNG and GLB
│   ├── <id>-lv1.png / <id>-lv1.glb      base display model
│   ├── <id>-lv2.png / <id>-lv2.glb      reinforced display model
│   ├── <id>-lv3.png / <id>-lv3.glb      advanced display model
│   ├── equipment-contact-sheet.png     27 archived models together
│   └── manifest.json                   file names and tier index
└── cards/               one example NFT card: 512 × 512 PNG
```

The pictures are renders. The game does not load them: it draws every fish and the rod live from the code below.

| Asset | Built by | Source |
| --- | --- | --- |
| Fish model | `buildFishMesh(spec)` | [`game/src/fish.ts`](../game/src/fish.ts) |
| Fish sprite, icon and NFT card | `fishSprite` / `fishIcon` / `fishCard` | [`game/src/portrait.ts`](../game/src/portrait.ts) |
| Fishing rod | `buildFishingNetMesh()` | [`game/src/gear.ts`](../game/src/gear.ts) |
| 13 Diving Accessories | `buildAccessoryModel(id, level)` | [`game/src/accessories.ts`](../game/src/accessories.ts), [`design/diving-gear-accessories-model.md`](../design/diving-gear-accessories-model.md) |
| Accessory 3D Studio | `accessory-preview.html` | [`game/accessory-preview.html`](../game/accessory-preview.html), [`game/src/accessory-preview.ts`](../game/src/accessory-preview.ts) |
| Preview page | `asset-library.html` | [`game/asset-library.html`](../game/asset-library.html), [`game/src/asset-library.ts`](../game/src/asset-library.ts) |
| Rod inspection and export | `gear-preview.html` | [`game/gear-preview.html`](../game/gear-preview.html), [`game/src/gear-preview.ts`](../game/src/gear-preview.ts) |
| Equipment upgrade display models | `buildUpgradeModel(id, level)` | [`game/src/upgrades.ts`](../game/src/upgrades.ts), [`game/src/upgrade-models/`](../game/src/upgrade-models/) |
| Equipment inspection and export | `equipment-preview.html` | [`game/equipment-preview.html`](../game/equipment-preview.html), [`game/src/equipment-preview.ts`](../game/src/equipment-preview.ts) |

---

## 2. Fish

There are 17 species in 6 rarities. Three things decide how a fish looks and behaves:

- The **species** sets the body shape, the fin proportions, the pattern and the swimming behaviour.
- The **rarity** sets the color range, the glow, the base speed and the value.
- The **seed** picks the exact color, size and name, so two fish of the same species are never quite the same.

Each picture below shows one fish of that species. The seeds the preview page uses are listed in [section 5](#5-rendering-the-pictures-again); most of the saved pictures were rendered with older seeds, see the note there.

Rarity depends only on the depth a fish is caught at, not on the map or the zone name: `RARITY_BY_DEPTH` in [`game/src/depth-odds.ts`](../game/src/depth-odds.ts) gives percent weights at anchor depths, interpolated in between and constant from 350 m down. The full table is in section 7 of the [main README](../README.md#7-game-design-parameters). Each rarity below lists a few points from it.

### Gallery

#### Common

Color `#b8c4cc` · value 1 · base speed 2.2 · base flee radius 3 · 90% at the surface, 58% at 50 m, 22% from 350 m down

| Sand Minnow | Grey Perch | Mud Goby |
| :---: | :---: | :---: |
| <img src="fish/sand-minnow.png" width="200" alt="Sand Minnow"> | <img src="fish/grey-perch.png" width="200" alt="Grey Perch"> | <img src="fish/mud-goby.png" width="200" alt="Mud Goby"> |
| slim · solid | perch · stripes | slim · spots |

#### Uncommon

Color `#5fd38d` · value 3 · base speed 2.8 · base flee radius 3.6 · 9.5% at the surface, 28% at 50 m, 26% from 350 m down

| Striped Wrasse | Coral Chromis | Silver Snapper |
| :---: | :---: | :---: |
| <img src="fish/striped-wrasse.png" width="200" alt="Striped Wrasse"> | <img src="fish/coral-chromis.png" width="200" alt="Coral Chromis"> | <img src="fish/silver-snapper.png" width="200" alt="Silver Snapper"> |
| slim · stripes | perch · glow | perch · mask |

#### Rare

Color `#4aa8ff` · value 10 · base speed 3.4 · base flee radius 4.4 · 0.5% at the surface, 10.5% at 50 m, 25% from 350 m down

| Azure Tang | Neon Cardinal | Spotted Grouper |
| :---: | :---: | :---: |
| <img src="fish/azure-tang.png" width="200" alt="Azure Tang"> | <img src="fish/neon-cardinal.png" width="200" alt="Neon Cardinal"> | <img src="fish/spotted-grouper.png" width="200" alt="Spotted Grouper"> |
| disc · mask | slim · stripes | bulky · spots |

#### Epic

Color `#b46cff` · value 35 · base speed 4.2 · base flee radius 5.2 · only below 15 m: 3% at 50 m, 16.5% from 350 m down

| Violet Lionfish | Ember Triggerfish | Ghost Angelfish |
| :---: | :---: | :---: |
| <img src="fish/violet-lionfish.png" width="200" alt="Violet Lionfish"> | <img src="fish/ember-triggerfish.png" width="200" alt="Ember Triggerfish"> | <img src="fish/ghost-angelfish.png" width="200" alt="Ghost Angelfish"> |
| perch · stripes | disc · mask | disc · glow |

#### Legendary

Color `#ffb340` · value 150 · base speed 5 · base flee radius 6 · only below 30 m: 0.5% at 50 m, 7.5% from 350 m down

| Golden Koi Dragon | Abyssal Sunfish | Crowned Sailfish |
| :---: | :---: | :---: |
| <img src="fish/golden-koi-dragon.png" width="200" alt="Golden Koi Dragon"> | <img src="fish/abyssal-sunfish.png" width="200" alt="Abyssal Sunfish"> | <img src="fish/crowned-sailfish.png" width="200" alt="Crowned Sailfish"> |
| long · stripes | bulky · glow | long · mask |

#### Mythic

Color `#ff5fd2` · value 800 · base speed 5.8 · base flee radius 7 · only below 50 m: 0.2% at 80 m, 3% from 350 m down

| Moonfin Leviathan | Prism Coelacanth |
| :---: | :---: |
| <img src="fish/moonfin-leviathan.png" width="200" alt="Moonfin Leviathan"> | <img src="fish/prism-coelacanth.png" width="200" alt="Prism Coelacanth"> |
| long · glow | bulky · spots |

### Body shapes

Every species starts from one of 5 body shapes (`SHAPES`). Sizes are in model units; at scale 1, one unit is 28 cm.

| Shape | Length | Height | Width | Tail | Dorsal fin | Looks like | Species |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `slim` | 1.5 | 0.42 | 0.28 | 0.45 | 0.25 | Small and slender | Sand Minnow, Mud Goby, Striped Wrasse, Neon Cardinal |
| `perch` | 1.3 | 0.62 | 0.34 | 0.5 | 0.35 | The classic fish outline | Grey Perch, Coral Chromis, Silver Snapper, Violet Lionfish |
| `disc` | 1 | 1.05 | 0.24 | 0.45 | 0.45 | Tall and flat, taller than it is long | Azure Tang, Ember Triggerfish, Ghost Angelfish |
| `long` | 2.3 | 0.4 | 0.3 | 0.6 | 0.5 | Long and low, the longest shape | Golden Koi Dragon, Crowned Sailfish, Moonfin Leviathan |
| `bulky` | 1.8 | 1.1 | 0.6 | 0.75 | 0.4 | Big, tall and thick | Spotted Grouper, Abyssal Sunfish, Prism Coelacanth |

The body is a tube of 7 hexagonal rings, closed at the nose and at the tail root. On top of that come a triangular dorsal fin, two pectoral fins, two eyes, and a tail on its own pivot so that it can wag. One fish is 134 triangles. Every face is flat-shaded and has a single color.

### Patterns

The pattern decides which faces get the accent color.

| Pattern | What it paints |
| --- | --- |
| `solid` | Nothing. The fish keeps its back, body and belly colors |
| `stripes` | Every second ring of the body, plus the dorsal fin and the tail. A roll has stripes 55% of the time; without them only the fins carry the accent |
| `spots` | Scattered faces on the upper body |
| `mask` | The upper body near the head, plus the tail |
| `glow` | Every third face on the upper body. The fish also glows at 0.18 or more, whatever its rarity |

### Colors

The rarity gives a range of hue, saturation and lightness, and the seed picks a point in that range. The accent hue is 140–220° away from the body hue.

| Rarity | Rarity color | Hue | Saturation | Lightness | Glow | Value |
| --- | --- | --- | --- | --- | --- | --- |
| common | `#b8c4cc` | 20–60° | 0.08–0.25 | 0.45–0.6 | 0 | 1 |
| uncommon | `#5fd38d` | 90–170° | 0.35–0.55 | 0.45–0.55 | 0 | 3 |
| rare | `#4aa8ff` | 185–225° | 0.65–0.85 | 0.5–0.6 | 0.05 | 10 |
| epic | `#b46cff` | 265–330° | 0.6–0.85 | 0.5–0.6 | 0.15 | 35 |
| legendary | `#ffb340` | 30–48° | 0.85–1 | 0.52–0.6 | 0.45 | 150 |
| mythic | `#ff5fd2` | 0–360° | 0.8–1 | 0.6–0.7 | 0.7 | 800 |

The builder derives the other colors from that one body color: the back is darker (lightness × 0.7), the belly is paler and less saturated, the fins shift the hue by 15°, and the accent is more saturated at lightness 0.55. Legendary fish are more metallic (0.45 instead of 0.1). Mythic fish cycle their glow through every hue while they swim.

### Size and names

- **Scale**: 0.85–1.25, multiplied by `1 + 0.12 × rarity index` (common is 0, mythic is 5). Rarer fish are bigger.
- **Length**: `shape length × scale × 28` cm.
- **Weight**: `(length / 30)³ × shape height × 0.7–1.1` kg.
- **Name**: an epithet from the rarity, then the species. For example "Starborn Moonfin Leviathan".

| Rarity | Epithets |
| --- | --- |
| common | Plain, Dusty, Little, Shy |
| uncommon | Banded, Lively, Bright, Speckled |
| rare | Glimmering, Deepwater, Royal, Twilight |
| epic | Phantom, Venomous, Storm, Midnight |
| legendary | Sunforged, Ancient, Crowned, Gilded |
| mythic | Prismatic, Eternal, Starborn |

### Species parameters

Shape. Each value multiplies the body shape above, and 1 leaves it unchanged.

| Species | Rarity | Body shape | Pattern | `tailTaper` | `headVolume` | `bodyWidth` | `dorsal` | `pectoral` | `tailSpread` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sand Minnow | common | `slim` | `solid` | 0.58 | 0.82 | 0.82 | 0.7 | 0.75 | 0.9 |
| Grey Perch | common | `perch` | `stripes` | 0.72 | 1.08 | 1 | 1.1 | 1 | 1 |
| Mud Goby | common | `slim` | `spots` | 0.8 | 1.2 | 1.15 | 0.5 | 1.3 | 0.8 |
| Striped Wrasse | uncommon | `slim` | `stripes` | 0.62 | 0.98 | 0.9 | 1.2 | 0.9 | 1.05 |
| Coral Chromis | uncommon | `perch` | `glow` | 0.7 | 0.92 | 0.86 | 1 | 0.85 | 1.1 |
| Silver Snapper | uncommon | `perch` | `mask` | 0.65 | 1.14 | 1.05 | 0.85 | 1.05 | 0.95 |
| Azure Tang | rare | `disc` | `mask` | 0.7 | 0.9 | 1 | 1.2 | 0.85 | 1.2 |
| Neon Cardinal | rare | `slim` | `stripes` | 0.56 | 0.85 | 0.78 | 0.8 | 0.8 | 1.25 |
| Spotted Grouper | rare | `bulky` | `spots` | 0.82 | 1.22 | 1.08 | 0.8 | 1.1 | 0.85 |
| Violet Lionfish | epic | `perch` | `stripes` | 0.72 | 0.96 | 0.95 | 1.9 | 1.45 | 1 |
| Ember Triggerfish | epic | `disc` | `mask` | 0.74 | 1.18 | 1.12 | 1 | 0.9 | 0.9 |
| Ghost Angelfish | epic | `disc` | `glow` | 0.64 | 0.88 | 0.92 | 1.45 | 1.25 | 1.08 |
| Golden Koi Dragon | legendary | `long` | `stripes` | 0.5 | 1.14 | 0.9 | 0.7 | 1.1 | 1.35 |
| Abyssal Sunfish | legendary | `bulky` | `glow` | 0.9 | 1.28 | 1.2 | 0.65 | 0.8 | 0.72 |
| Crowned Sailfish | legendary | `long` | `mask` | 0.46 | 0.82 | 0.72 | 2.1 | 0.85 | 1.5 |
| Moonfin Leviathan | mythic | `long` | `glow` | 0.42 | 1.2 | 0.88 | 1.35 | 1.2 | 1.55 |
| Prism Coelacanth | mythic | `bulky` | `spots` | 0.78 | 1.12 | 1.08 | 1.15 | 1.35 | 1.05 |

- `tailTaper`: how thin the body is at the tail root. Lower is thinner. The body is back to full size 35% of the way along.
- `headVolume`: how big the head is. Higher is bigger. It grows in over the last 42% of the body.
- `bodyWidth`: how thick the body is.
- `dorsal`: how tall the dorsal fin is.
- `pectoral`: how far the pectoral fins stick out.
- `tailSpread`: how large the tail fin is.

Behaviour. `swimSpeed` and `fleeRadius` multiply the base values of the rarity. The last two columns show the result.

| Species | `swimSpeed` | `turnRate` | `fleeRadius` | Speed | Flee radius |
| --- | --- | --- | --- | --- | --- |
| Sand Minnow | 1.18 | 3.4 | 0.95 | 2.6 | 2.85 |
| Grey Perch | 0.94 | 2.5 | 1 | 2.07 | 3 |
| Mud Goby | 0.78 | 2.1 | 0.9 | 1.72 | 2.7 |
| Striped Wrasse | 1.12 | 3.2 | 1.05 | 3.14 | 3.78 |
| Coral Chromis | 1.08 | 3 | 1.1 | 3.02 | 3.96 |
| Silver Snapper | 0.98 | 2.7 | 1.02 | 2.74 | 3.67 |
| Azure Tang | 1.06 | 2.8 | 1.05 | 3.6 | 4.62 |
| Neon Cardinal | 1.25 | 3.7 | 1.14 | 4.25 | 5.02 |
| Spotted Grouper | 0.82 | 2 | 0.96 | 2.79 | 4.22 |
| Violet Lionfish | 0.9 | 2.4 | 1.15 | 3.78 | 5.98 |
| Ember Triggerfish | 0.88 | 2.2 | 1.1 | 3.7 | 5.72 |
| Ghost Angelfish | 1 | 2.6 | 1.2 | 4.2 | 6.24 |
| Golden Koi Dragon | 0.94 | 2 | 1.12 | 4.7 | 6.72 |
| Abyssal Sunfish | 0.7 | 1.6 | 1.25 | 3.5 | 7.5 |
| Crowned Sailfish | 1.2 | 2.3 | 1.3 | 6 | 7.8 |
| Moonfin Leviathan | 0.88 | 1.8 | 1.35 | 5.1 | 9.45 |
| Prism Coelacanth | 0.76 | 1.9 | 1.3 | 4.41 | 9.1 |

A fish cruises at 55% of its speed. When the diver comes inside the flee radius, it swims away at 1.6 to 2.6 times its speed, faster the closer the diver is. `turnRate` is how quickly it changes direction; higher turns faster.

### From seed to NFT card

`rollFish(seed, depth, odds?)` → `FishSpec` → `buildFishMesh(spec)` → `fishCard(spec)`

The same seed at the same depth always gives the same fish, so anyone can render a card again and check it. The depth sets the rarity odds and is stored on the fish with its catch value; a third argument, `odds`, overrides the odds (the title screen uses it). `fishCard` draws the 512 × 512 image that gets minted: the rarity color as the backdrop, the fish, and its name, size, depth and id.

<img src="cards/moonfin-leviathan.png" width="320" alt="Example NFT card: Starborn Moonfin Leviathan">

---

## 3. Fishing rod

<img src="gear/fishing-net-dark.png" width="720" alt="The faceted fishing rod, used underwater as a landing net">

[Inspection preview](gear/fishing-net-faceted-preview.png) · [Download Lv1 GLB](gear/fishing-net-faceted.glb)

The design doc calls this item a fishing rod. Underwater, the game uses it as a landing net: a carbon blank, EVA-style grip, spinning reel and guide rings lead to an elliptical hoop and a fine nylon web. `buildFishingNetMesh()` returns the complete `group`, the upgrade pivot `mouth`, and a catch marker called `tip`. Mesh materials use `flatShading: true`; their metalness, roughness and clearcoat describe the hardware without texture files. The GLB is the base Lv1 asset, with per-face normals baked in to preserve the facets in other viewers.

| Part | Geometry | Size (model units) | Color | Position along the rod (x) |
| --- | --- | --- | --- | --- |
| Arm | Box | 0.7 × 0.14 × 0.14 | `#1d2b3a`, the wetsuit color | 0–0.7 |
| Butt cap | 12-sided cylinder | radius 0.105–0.12, length 0.1 | `#142027` | 0.61–0.71 |
| Grip and bands | 12-sided tapered cylinder, torus bands | grip radius 0.105–0.135, length 0.46; band radius 0.12 | `#9b5d3c`, bands `#142027` | grip 0.68–1.14; bands 0.72 and 1.1 |
| Reel seat and collar | 12-sided tapered cylinder, torus | radius 0.073–0.082, length 0.28; collar radius 0.084 | `#46616a`, collar `#9eafb2` | seat 1.12–1.4; collar 1.4 |
| Reel body | Sphere, 16 × 10 segments | radius 0.17, scaled (0.82, 1.18, 0.78) | `#263b46` | 1.25, below the shaft |
| Reel plate, spool and bail | 16-sided cylinders and torus rings | plate radius 0.185, thickness 0.035; spool radius 0.135, length 0.13; bail radius 0.19 | `#9eafb2`, spool `#a9b6b8` | 1.25–1.3 |
| Reel handle and knob | 8-sided cylinder, sphere | handle radius 0.014; knob radius 0.045 | `#9eafb2`, knob `#263b46` | handle 1.34–1.53; knob 1.55 |
| Carbon blank and accent | 12-sided tapered cylinder, 8-sided accent | blank radius 0.022–0.068, length 1.34; accent radius 0.008–0.011, length 1.15 | `#17242d`, accent `#46616a` | blank 1.31–2.65; accent 1.505–2.655 |
| Guide rings | 12-sided torus | radii 0.065, 0.052, 0.042, 0.033; tube 0.009 | `#9eafb2` | 1.67, 1.93, 2.18, 2.4 |
| Hoop and inner guard | Elliptical tube, 32 path × 8 radial segments | hoop radii y/z 0.52/0.47; guard 0.47/0.42; tube 0.038 | `#6f9698`, guard `#46616a` | 2.7 |
| Web | Diamond-weave line segments | depth 0.78; gathered radius 0.075 to hoop radii 0.52/0.47 | `#b9d6d7` at 38% opacity | 1.92–2.7 |
| Mouth braces | 8-sided cylinders | radius 0.014, from the shaft to y ±0.52 | `#6f9698` | 2.5–2.7 |
| `tip` / `Catch_Centre` | Empty marker | – | – | 2.7, the middle of the hoop |

- **Pivot**: the origin of the model is the diver's shoulder, and the rod points along +x. `diver.ts` attaches it to the body at `(0.6, 0, 0.3)` and turns the whole group for the swing.
- **Catch point**: `Space` swings the rod. The nearest fish within the net tier's catch radius of `tip` is caught, and the net holds as many fish as the tier's capacity. The tiers are `ROD_TIERS` in [`game/src/equipment.ts`](../game/src/equipment.ts): Lv1 2.4 m and 6 fish, Lv2 2.8 m and 8, Lv3 3.2 m and 10.
- **Web**: 224 line segments in one draw call. Seven rows of 16 points have alternating half-cell offsets; paired diagonals form diamonds, with seams only at the gathered end and rim.
- **Not built yet**: the rod, bait and boat upgrades in section 7.1 of the [design doc](../design/game-design-document.md#7-经济与升级) (in Chinese) are design only. The net tiers are the only upgrade in the game.
- **Upgrades**: three tiers are implemented. `Diver.setNetLevel()` scales only `mouth` (hoop, guard, web and braces), by 15% per tier above Lv1; the grip, reel, shaft and catch centre keep their positions.

| Tier | Net capacity | Catch radius | Mouth scale |
| --- | --- | --- | --- |
| Lv1 · Basic Net | 6 fish | 2.4 | 1.00 |
| Lv2 · Reinforced Net | 8 fish | 2.8 | 1.15 |
| Lv3 · Abyssal Net | 10 fish | 3.2 | 1.30 |

Start `npm run game` and open <http://localhost:5173/gear-preview.html> to rotate and zoom the actual game model, inspect all three levels, and export PNG or GLB. PNG captures the current view and tier; GLB always exports the base Lv1 model without the preview floor, lights or camera.

---

## 4. Using the assets

**As pictures.** The PNGs in this folder can go straight into slides, the Devpost page or a video. The fish sprites and `gear/fishing-net.png` have a transparent background. `gear/fishing-net-dark.png` has dark water behind it, because the pale web is hard to see on a light background.

**In code.** Build the model, or ask for a picture at any size:

```ts
import { rollFish, buildFishMesh } from './fish';
import { fishCard, fishSprite } from './portrait';
import { buildFishingNetMesh } from './gear';

const spec = rollFish(43, 350);             // Starborn Moonfin Leviathan, caught at 350 m
scene.add(buildFishMesh(spec).group);       // the 3D model
img.src = fishSprite(spec, 256);            // transparent PNG as a data URL, any size
img.src = fishCard(spec);                   // the 512 × 512 NFT card

const rod = buildFishingNetMesh();
scene.add(rod.group);                       // rod.tip marks the middle of the hoop
```

---

## 5. Rendering the pictures again

The pictures go out of date when someone changes a model. To render them again:

1. Start the game: `npm run game`.
2. Open <http://localhost:5173/asset-library.html>. The page draws every species and the rod with the current code. It only exists on the dev server and is not part of the production build.
3. Every tile has a download link with the right file name. Save the files into `assets/fish/`, `assets/gear/` and `assets/cards/`.

For another size, use the console on that page: `await assetLibrary.sprite('azure-tang', 1024)` returns a data URL.

The page rolls every seed at 350 m, the deepest anchor in `RARITY_BY_DEPTH`, where every rarity can roll (mythic included). It uses the lowest seed that rolls each species there. A striped species waits for a roll that has stripes. These are the fish the page draws:

| Rarity | Species | Seed | Call |
| --- | --- | --- | --- |
| common | Grey Perch | 8 | `rollFish(8, 350)` |
| common | Mud Goby | 9 | `rollFish(9, 350)` |
| common | Sand Minnow | 7 | `rollFish(7, 350)` |
| uncommon | Coral Chromis | 14 | `rollFish(14, 350)` |
| uncommon | Silver Snapper | 24 | `rollFish(24, 350)` |
| uncommon | Striped Wrasse | 27 | `rollFish(27, 350)` |
| rare | Azure Tang | 1 | `rollFish(1, 350)` |
| rare | Neon Cardinal | 11 | `rollFish(11, 350)` |
| rare | Spotted Grouper | 5 | `rollFish(5, 350)` |
| epic | Ember Triggerfish | 20 | `rollFish(20, 350)` |
| epic | Ghost Angelfish | 30 | `rollFish(30, 350)` |
| epic | Violet Lionfish | 2 | `rollFish(2, 350)` |
| legendary | Abyssal Sunfish | 107 | `rollFish(107, 350)` |
| legendary | Crowned Sailfish | 36 | `rollFish(36, 350)` |
| legendary | Golden Koi Dragon | 89 | `rollFish(89, 350)` |
| mythic | Moonfin Leviathan | 43 | `rollFish(43, 350)` |
| mythic | Prism Coelacanth | 104 | `rollFish(104, 350)` |

> **The PNGs in this folder are older than this table.** They were rendered when rarity came from the zone, with different seeds. Five seeds are unchanged (Grey Perch 8, Azure Tang 1, Spotted Grouper 5, Violet Lionfish 2, Moonfin Leviathan 43), so those sprites still match. The other 12 sprites show another fish of the same species: same shape and pattern, different exact color and size. The example card is the same Starborn Moonfin Leviathan (90 cm, 7.83 kg, #0000002b), but the saved PNG reads "caught at 48 m"; the page now renders it as "caught at 350 m". Render the pictures again (steps above) to bring them in line.

---

## 6. Adding or changing an asset

**A new species**

1. Add a `SpeciesProfile` to `SPECIES_BY_RARITY` in `fish.ts`, under its rarity. Choose a body shape and a pattern, then set the multipliers.
2. Open the preview page and check that it reads as a different fish from its neighbours.
3. Save its sprite as `assets/fish/<species-name>.png` and add it to both READMEs in this folder.

> **This changes existing seeds.** `rollFish` picks the species by its position in the rarity's list. If you add or remove a species, an existing seed can roll a different species in that rarity. Fish already in a player's collection keep the species they were saved with. But rolling an old seed again gives a different fish, so it no longer matches a card minted before the change.

**A new body shape or pattern**

- Body shape: add it to `Archetype` and to `SHAPES`.
- Pattern: add it to `FishPattern` and to the `switch` in `buildFishMesh`.

**A different look for an existing species**

Editing a profile changes how every fish of that species is drawn, including the ones players already have. Card images that are already minted stay as they were uploaded.

**The rod**

Edit `buildFishingNetMesh()` in `gear.ts`. Keep the origin at the shoulder and the rod along +x, and keep `tip` in the middle of the hoop, because catches are measured from it. Then render `gear/` again.

**After any change**, run `npm --prefix game run build`, render the pictures again, and update the tables in both READMEs here.

---

## 7. Equipment upgrade models

Ten classes have three separately built tiers each (**30 matte, broadly faceted PBR display models**), with realistic proportions and changes to the hardware as well as the colors. The 27 models archived under `assets/upgrades/` predate the stand-alone reel; export the 3 reel tiers from the equipment preview page to complete the archive. [`buildUpgradeModel(id, level)`](../game/src/upgrades.ts) supplies the workbench and equipment catalog. These are display assets; generating or exporting them does not connect purchase handling, boat travel, or the fins, reserve-air and light effects to gameplay. The diver's approved runtime landing net remains in [`gear.ts`](../game/src/gear.ts).

<img src="upgrades/equipment-contact-sheet.png" width="1080" alt="All nine equipment classes, with Lv1, Lv2 and Lv3 side by side">

[Full contact sheet](upgrades/equipment-contact-sheet.png) · [Asset index](upgrades/manifest.json)

Each cell below links the corresponding PNG and GLB in `assets/upgrades/`. File names are `<id>-lv1.png` / `<id>-lv1.glb`, then `lv2` and `lv3`; IDs retain their exact spelling, including `boatSpeed`, `boatHull` and `boatDeck`. PNGs are 768 × 512 with transparency. GLBs contain the model and materials, with explicit face normals, and no studio lights, floor or camera. Display exports are centered with a longest dimension of 2 model units; this is a presentation scale rather than meters.

| Class / ID | Lv1 · Basic | Lv2 · Reinforced | Lv3 · Advanced |
| --- | --- | --- | --- |
| Fishing rod / `rod` | Short blank, wooden grip and spinning reel<br>[PNG](upgrades/rod-lv1.png) · [GLB](upgrades/rod-lv1.glb) | Longer blank, split EVA grip and guide braces<br>[PNG](upgrades/rod-lv2.png) · [GLB](upgrades/rod-lv2.glb) | Long carbon blank and adjustable drag hardware<br>[PNG](upgrades/rod-lv3.png) · [GLB](upgrades/rod-lv3.glb) |
| Bait / `bait` | Curved soft worm and single hook<br>[PNG](upgrades/bait-lv1.png) · [GLB](upgrades/bait-lv1.glb) | Hard fish lure with diving lip<br>[PNG](upgrades/bait-lv2.png) · [GLB](upgrades/bait-lv2.glb) | Luminous metal blade and two treble hooks<br>[PNG](upgrades/bait-lv3.png) · [GLB](upgrades/bait-lv3.glb) |
| Boat propulsion / `boatSpeed` | Pair of shaped wooden oars<br>[PNG](upgrades/boatSpeed-lv1.png) · [GLB](upgrades/boatSpeed-lv1.glb) | Single outboard motor with tiller and propeller<br>[PNG](upgrades/boatSpeed-lv2.png) · [GLB](upgrades/boatSpeed-lv2.glb) | Twin outboards with steering link<br>[PNG](upgrades/boatSpeed-lv3.png) · [GLB](upgrades/boatSpeed-lv3.glb) |
| Boat hull / `boatHull` | Open wooden hull, interior frames and seats<br>[PNG](upgrades/boatHull-lv1.png) · [GLB](upgrades/boatHull-lv1.glb) | Side reinforcement and reinforced transom<br>[PNG](upgrades/boatHull-lv2.png) · [GLB](upgrades/boatHull-lv2.glb) | Collision rubrail and additional gunwale hardware<br>[PNG](upgrades/boatHull-lv3.png) · [GLB](upgrades/boatHull-lv3.glb) |
| Fishing deck / `boatDeck` | Planked deck, railing and one hollow rod holder<br>[PNG](upgrades/boatDeck-lv1.png) · [GLB](upgrades/boatDeck-lv1.glb) | Larger deck, two holders and preparation table<br>[PNG](upgrades/boatDeck-lv2.png) · [GLB](upgrades/boatDeck-lv2.glb) | Three holders, preparation table and fish locker<br>[PNG](upgrades/boatDeck-lv3.png) · [GLB](upgrades/boatDeck-lv3.glb) |
| Landing net / `net` | Small elliptical rim and diamond nylon bag<br>[PNG](upgrades/net-lv1.png) · [GLB](upgrades/net-lv1.glb) | Larger mouth and reinforced rim rail<br>[PNG](upgrades/net-lv2.png) · [GLB](upgrades/net-lv2.glb) | Largest mouth and additional lateral braces<br>[PNG](upgrades/net-lv3.png) · [GLB](upgrades/net-lv3.glb) |
| Fins / `fins` | Short rubber blades, hollow foot pockets and drain slots<br>[PNG](upgrades/fins-lv1.png) · [GLB](upgrades/fins-lv1.glb) | Wider channeled blades and molded ribs<br>[PNG](upgrades/fins-lv2.png) · [GLB](upgrades/fins-lv2.glb) | Long carbon blades with fine reinforcing ribs<br>[PNG](upgrades/fins-lv3.png) · [GLB](upgrades/fins-lv3.glb) |
| Reserve air / `tank` | Empty harness and cylinder clamps; **no bottle or reserve air**<br>[PNG](upgrades/tank-lv1.png) · [GLB](upgrades/tank-lv1.glb) | Rounded single bottle, valve, hose and mouthpiece<br>[PNG](upgrades/tank-lv2.png) · [GLB](upgrades/tank-lv2.glb) | Twin bottles, manifold and pressure gauge with needle<br>[PNG](upgrades/tank-lv3.png) · [GLB](upgrades/tank-lv3.glb) |
| Headlamp / `lamp` | Single lamp, headband and rear battery<br>[PNG](upgrades/lamp-lv1.png) · [GLB](upgrades/lamp-lv1.glb) | Wider reflector cup and impact guard<br>[PNG](upgrades/lamp-lv2.png) · [GLB](upgrades/lamp-lv2.glb) | Two optical heads and larger rear battery<br>[PNG](upgrades/lamp-lv3.png) · [GLB](upgrades/lamp-lv3.glb) |

Start `npm run game`, then open <http://localhost:5173/equipment-preview.html> ([page source](../game/equipment-preview.html)). Select a class and level, drag to rotate, scroll to zoom, or reset the view. The gallery renders all 30 tiers. **Generate all assets** creates the GLB links and `manifest.json`; download each PNG/GLB and the contact sheet into `assets/upgrades/`. The manifest records ID, level, class name, reference effect text, filenames and GLB byte size. Its effect text describes upgrade definitions, not a guarantee that those effects are wired into gameplay.

To change these assets, edit the relevant builder in [`upgrade-models/fishing.ts`](../game/src/upgrade-models/fishing.ts), [`marine.ts`](../game/src/upgrade-models/marine.ts) or [`diving.ts`](../game/src/upgrade-models/diving.ts), rebuild, and regenerate the affected PNG/GLB files and the index. The class list and reference effects come from `UPGRADES` in `upgrades.ts`.
