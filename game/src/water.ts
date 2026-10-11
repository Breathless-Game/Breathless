import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';
import { ROGUE } from './storm';

/** Colored low-poly facets and a faceted road of sun or moon glitter in one water draw. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#367f91');
  private readonly nightWater = new THREE.Color('#17364d');
  private readonly waterUniforms = {
    uWaterTime: { value: 0 },
    uWaterEffects: { value: 1 },
    uWaterDetail: { value: 1 },
    uWaterWind: { value: 0 },
    uWaterMapWaves: { value: 1 },
    // A rogue wave: where its crest is (x), how high it stands, and which way it travels (+1 or -1).
    uWaterRogue: { value: new THREE.Vector3(0, 0, 1) },
    uWaterAbove: { value: 1 },
    uWaterSky: { value: new THREE.Color('#a8e3f5') },
    uWaterHorizon: { value: new THREE.Color('#e5f3e6') },
    uWaterLightColor: { value: new THREE.Color('#fff3d7') },
    uWaterLightDirection: { value: new THREE.Vector3(0, 0.4, -0.9).normalize() },
    uWaterLightStrength: { value: 1 },
  };

  constructor() {
    super({
      color: '#367f91', flatShading: true, roughness: 0.85, metalness: 0,
      transparent: true, opacity: 0.78, depthWrite: false, side: THREE.DoubleSide,
    });
    this.forceSinglePass = true;
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.waterUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          attribute vec4 aWaterFacet;
          attribute vec4 aWaterPatch;
          varying vec4 vWaterPatch;
          varying vec3 vWaterFacetCenter;
          varying vec2 vWaterFacetTone;
          uniform float uWaterTime;
          uniform float uWaterWind;
          uniform float uWaterMapWaves;
          uniform vec3 uWaterRogue;
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Shared corners evaluate the same two waves on the GPU. No per-frame
          // geometry upload or CPU normal rebuild is needed at any quality.
          transformed.y += (sin(position.x * 0.15 + uWaterTime * 1.3) * 0.35
            + cos(position.z * 0.2 + uWaterTime * 0.9) * 0.25)
            * (1.0 + uWaterWind * 0.75) * uWaterMapWaves;
          // A rogue wave is one more crest on the same facets, sweeping along x: steep on
          // the face that leads, long behind (rogueProfile in storm.ts). It flattens out
          // before it reaches the camera, which stands just this side of the boat.
          float rogueAhead = (position.x - uWaterRogue.x) * uWaterRogue.z;
          float rogueAcross = rogueAhead / (${ROGUE.width.toFixed(1)} * (rogueAhead > 0.0 ? ${ROGUE.steep.toFixed(2)} : ${ROGUE.back.toFixed(2)}));
          transformed.y += uWaterRogue.y * exp(-rogueAcross * rogueAcross) * (1.0 - smoothstep(34.0, 46.0, position.z));
        `)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWaterPatch = aWaterPatch;
          vWaterFacetCenter = (modelMatrix * vec4(aWaterFacet.x, 0.0, aWaterFacet.y, 1.0)).xyz;
          vWaterFacetTone = aWaterFacet.zw;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec4 vWaterPatch;
          varying vec3 vWaterFacetCenter;
          varying vec2 vWaterFacetTone;
          uniform float uWaterTime;
          uniform float uWaterEffects;
          uniform float uWaterDetail;
          uniform float uWaterWind;
          uniform float uWaterAbove;
          uniform vec3 uWaterSky;
          uniform vec3 uWaterHorizon;
          uniform vec3 uWaterLightColor;
          uniform vec3 uWaterLightDirection;
          uniform float uWaterLightStrength;
        `)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          // Celestial reflection below supplies the stylized highlight. A
          // second smooth specular lobe would erase the triangle silhouettes.
          reflectedLight.directSpecular = vec3(0.0);
        `)
        .replace('#include <opaque_fragment>', `
          vec3 waterNormal = inverseTransformDirection(normal, viewMatrix);
          // All three vertices carry the same seed: hue and brightness belong
          // to a whole face, never a screen-space noise or smooth wave stripe.
          float facetTone = vWaterFacetTone.x;
          vec3 facetCool = vec3(0.82, 0.96, 1.08);
          vec3 facetWarm = vec3(1.02, 1.02, 0.94);
          vec3 facetPalette = mix(facetCool, facetWarm, facetTone);
          float facetValue = mix(0.86, 1.08, facetTone);
          outgoingLight *= mix(vec3(1.0), facetPalette * facetValue, 0.82 * uWaterAbove + 0.18);

          if (uWaterEffects > 0.5) {
            vec3 waterView = normalize(cameraPosition - vWaterFacetCenter);
            float waterFacing = clamp(dot(waterNormal, waterView), 0.0, 1.0);
            float waterFresnel = 0.035 + 0.60 * pow(1.0 - waterFacing, 5.0);
            vec3 waterReflection = reflect(-waterView, waterNormal);
            vec3 waterSky = mix(uWaterHorizon, uWaterSky, smoothstep(0.0, 0.6, abs(waterReflection.y)));
            // Retain blue-green body color at grazing angles so reflected sky
            // paints facets instead of washing the sea into a pale mirror.
            vec3 reflectedFacet = waterSky * facetPalette * mix(0.35, 0.51, facetTone);
            outgoingLight = mix(outgoingLight, reflectedFacet, waterFresnel * mix(0.04, 0.48, uWaterAbove));

            // Sun glitter. A facet shines when it is tilted to mirror the light into
            // the camera, so compare the slope that would do it with the slope the
            // facet has. Sea-surface slopes are spread like a Gaussian (Cox and Munk),
            // wider in wind: the road of light narrows toward a low sun and breaks
            // into scattered glints at its edges by itself, for the sun or the moon.
            vec3 waterToward = waterView + uWaterLightDirection;
            vec3 waterHalf = normalize(waterToward);
            // The celestial orbits are flattened to stay in frame; this floor keeps
            // the road from thinning to a hairline when the light sits on the horizon.
            vec2 mirrorSlope = waterToward.xz / max(waterToward.y, 0.2);
            // The swell is gentle, so its slope is exaggerated: the glints ride the waves.
            vec2 facetSlope = waterNormal.xz / max(waterNormal.y, 0.2) * 3.0;
            vec2 miss = mirrorSlope - facetSlope;
            float roughness = mix(0.035, 0.10, uWaterWind) * mix(1.25, 1.0, uWaterDetail * 0.5);
            float glint = exp(-dot(miss, miss) / (2.0 * roughness));
            // Water mirrors more at a grazing angle: the road brightens toward the horizon.
            float mirror = 0.02 + 0.98 * pow(1.0 - clamp(dot(waterView, waterHalf), 0.0, 1.0), 5.0);
            float glare = mix(0.45, 1.0, smoothstep(0.02, 0.45, mirror));
            // Every facet has its own threshold and slow twinkle. Near the middle of
            // the road almost all of them pass; toward the edges only a few do.
            float facetPulse = 0.5 + 0.5 * sin(uWaterTime * (0.65 + uWaterWind * 0.25)
              + vWaterFacetTone.y * 6.283 + vWaterFacetCenter.x * 0.13);
            float lit = smoothstep(0.42, 0.62, glint + (vWaterFacetTone.y - 0.5) * 0.5 + (facetPulse - 0.5) * 0.24);
            float energy = glint * lit;
            // The light keeps its colour where it is faint and whitens where it is strong.
            float lightLuma = dot(uWaterLightColor, vec3(0.2126, 0.7152, 0.0722));
            vec3 lightTint = max(vec3(0.0), mix(vec3(lightLuma), uWaterLightColor, 1.7));
            vec3 glintColor = mix(lightTint, vec3(1.0, 0.98, 0.93), smoothstep(0.6, 1.0, energy) * 0.5);
            float lightAbove = uWaterLightStrength * uWaterAbove;

            // A faint wash of the light's colour under the whole road, one tone per facet.
            float road = exp(-dot(miss, miss) / (2.0 * roughness * 7.0));
            outgoingLight += lightTint * road * glare * 0.11 * lightAbove;
            // Looking toward a low light, the faces of the swell that lean to the
            // camera let it through and glow green.
            float backlit = max(0.0, dot(normalize(waterView.xz), -normalize(uWaterLightDirection.xz)));
            float leaning = clamp(dot(facetSlope, normalize(waterView.xz)) * 2.2, 0.0, 1.0);
            outgoingLight += vec3(0.20, 0.78, 0.62) * uWaterLightColor * backlit * leaning * road * 0.22 * lightAbove;

            // Slice an inset triangle into a trapezoid or wedge across the line of
            // sight, as real glints are stretched. Strong facets fill; faint ones
            // are slivers, so the road has a solid heart and a ragged edge.
            float inset = min(min(vWaterPatch.x, vWaterPatch.y), vWaterPatch.z);
            float edgeAA = max(fwidth(inset), 0.002);
            float polygon = smoothstep(0.03, 0.03 + edgeAA, inset);
            float bandCenter = 0.38 + vWaterFacetTone.x * 0.22;
            float bandDistance = abs(vWaterPatch.w - bandCenter);
            // A facet at the camera's feet fills the screen; its glint stays a sliver.
            float reach = smoothstep(5.0, 42.0, distance(vWaterFacetCenter.xz, cameraPosition.xz));
            float bandWidth = mix(0.035, 0.32, energy * energy) * mix(0.18, 1.0, reach) * mix(0.85, 1.15, uWaterDetail * 0.5);
            float bandAA = max(fwidth(vWaterPatch.w), 0.002);
            // A bright core inside a dimmer, wider band of the same shape: the
            // glint falls off in two flat steps instead of ending like cut paper.
            float core = 1.0 - smoothstep(bandWidth, bandWidth + bandAA, bandDistance);
            float halo = 1.0 - smoothstep(bandWidth * 2.3 + 0.02, bandWidth * 2.3 + 0.02 + bandAA, bandDistance);
            polygon *= core * 0.74 + halo * 0.26;
            float highlight = clamp(energy * glare * polygon * lightAbove * mix(0.7, 1.0, reach), 0.0, 1.0);
            // Added light, not paint: the facet's own shading stays visible under it.
            outgoingLight += glintColor * highlight * 0.92;
            diffuseColor.a = clamp(diffuseColor.a + highlight * 0.12, 0.0, 0.92);
          }
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    return 'deepbreath-water-facets-v4';
  }

  setEffectsEnabled(enabled: boolean): void {
    this.waterUniforms.uWaterEffects.value = enabled ? 1 : 0;
  }

  /** Raise a rogue wave `height` m tall with its crest at `x`, travelling `dir` (+1 or -1). A height of 0 is calm. */
  setRogueWave(x: number, height: number, dir: number): void {
    this.waterUniforms.uWaterRogue.value.set(x, height, dir < 0 ? -1 : 1);
  }

  update(time: number, lighting: LightingState, cameraY: number, quality: RenderQuality, weather?: WeatherState, mapWaves = 1): void {
    const uniforms = this.waterUniforms;
    uniforms.uWaterTime.value = time;
    uniforms.uWaterDetail.value = quality.waterDetail;
    uniforms.uWaterWind.value = weather?.wind ?? 0;
    uniforms.uWaterMapWaves.value = mapWaves;
    uniforms.uWaterAbove.value = THREE.MathUtils.smoothstep(cameraY, -0.65, 0.9);
    uniforms.uWaterSky.value.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    uniforms.uWaterHorizon.value.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightDirection.value.set(...lighting.direction).normalize();
    uniforms.uWaterLightStrength.value = Math.min(1.1, 0.52 + lighting.sunIntensity * 0.28)
      * (1 - (weather?.cloud ?? 0) * 0.93);
    this.color.copy(this.dayWater).lerp(this.nightWater, lighting.nightMix);
    this.opacity = THREE.MathUtils.lerp(0.30, 0.78, uniforms.uWaterAbove.value);
  }

  /**
   * Let the water mirror a glow in the sky (the aurora). Call after `update`, which resets the
   * sky colours; `amount` is 0..1. The zenith takes more of it than the horizon.
   */
  reflectGlow(color: THREE.Color, amount: number): void {
    if (amount <= 0) return;
    this.waterUniforms.uWaterSky.value.lerp(color, Math.min(1, amount) * 0.45);
    this.waterUniforms.uWaterHorizon.value.lerp(color, Math.min(1, amount) * 0.28);
  }
}
