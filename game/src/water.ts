import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';
import { ROGUE } from './storm';
import { whitecapStrength } from './water-foam';
import { reflectionStrength } from './water-reflections';

/** Colored low-poly facets with integrated sun and moon reflections in one water draw. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#367f91');
  private readonly nightWater = new THREE.Color('#17364d');
  private readonly waterUniforms = {
    uWaterTime: { value: 0 },
    uWaterEffects: { value: 1 },
    uWaterDetail: { value: 1 },
    uWaterWind: { value: 0 },
    uWaterMapWaves: { value: 1 },
    uWaterFoamStrength: { value: 0 },
    uWaterFoamLight: { value: 1 },
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
          varying vec3 vWaterFacetCenter;
          varying vec2 vWaterFacetTone;
          varying vec3 vWaterSurface;
          uniform float uWaterTime;
          uniform float uWaterWind;
          uniform float uWaterMapWaves;
          uniform vec3 uWaterRogue;
          float waterHeight(vec2 p) {
            float swell = (sin(p.x * 0.15 + uWaterTime * 1.3) * 0.35
              + cos(p.y * 0.2 + uWaterTime * 0.9) * 0.25)
              * (1.0 + uWaterWind * 0.75) * uWaterMapWaves;
            float ahead = (p.x - uWaterRogue.x) * uWaterRogue.z;
            float across = ahead / (${ROGUE.width.toFixed(1)} * (ahead > 0.0 ? ${ROGUE.steep.toFixed(2)} : ${ROGUE.back.toFixed(2)}));
            return swell + uWaterRogue.y * exp(-across * across) * (1.0 - smoothstep(34.0, 46.0, p.y));
          }
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Shared corners and reflection centres use the same animated surface.
          transformed.y += waterHeight(position.xz);
        `)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWaterFacetCenter = (modelMatrix * vec4(aWaterFacet.x, waterHeight(aWaterFacet.xy), aWaterFacet.y, 1.0)).xyz;
          vWaterFacetTone = aWaterFacet.zw;
          // Match the displacement's local z (the surface itself is translated behind the boat).
          vWaterSurface = transformed;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterFacetCenter;
          varying vec2 vWaterFacetTone;
          varying vec3 vWaterSurface;
          uniform float uWaterTime;
          uniform float uWaterEffects;
          uniform float uWaterDetail;
          uniform float uWaterWind;
          uniform float uWaterFoamStrength;
          uniform float uWaterFoamLight;
          uniform vec3 uWaterRogue;
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

          if (uWaterDetail > 1.5 && uWaterEffects > 0.5) {
            float rippleFootprint = length(fwidth(vWaterSurface.xz));
            float rippleDetail = 1.0 - smoothstep(0.035, 0.16, rippleFootprint);
            float smallRipple = sin(vWaterSurface.x * 8.5 + vWaterSurface.z * 3.2 - uWaterTime * 1.8)
              * cos(vWaterSurface.z * 6.7 - vWaterSurface.x * 1.1 + uWaterTime * 0.7);
            outgoingLight *= 1.0 + smallRipple * rippleDetail * 0.065 * uWaterAbove;
          }

          if (uWaterEffects > 0.5) {
            vec3 waterView = normalize(cameraPosition - vWaterFacetCenter);
            float waterFacing = clamp(dot(waterNormal, waterView), 0.0, 1.0);
            float waterFresnel = 0.035 + 0.60 * pow(1.0 - waterFacing, 5.0);
            vec3 waterReflection = reflect(-waterView, waterNormal);
            vec3 waterSky = mix(uWaterHorizon, uWaterSky, smoothstep(0.0, 0.6, abs(waterReflection.y)));
            // Reflection changes the colour of the existing face. It does not
            // draw an inset wedge, halo or opacity mask over that face.
            vec3 reflectedFacet = waterSky * facetPalette * mix(0.35, 0.48, facetTone);
            outgoingLight = mix(outgoingLight, reflectedFacet, waterFresnel * 0.28 * uWaterAbove);

            vec3 waterToward = waterView + uWaterLightDirection;
            vec2 mirrorSlope = waterToward.xz / max(waterToward.y, 0.2);
            vec2 facetSlope = waterNormal.xz / max(waterNormal.y, 0.2) * 2.0;
            vec2 miss = mirrorSlope - facetSlope;
            // Wind broadens the same reflection at every quality. Face normals,
            // rather than an independent twinkle, decide which facets brighten.
            float spread = mix(0.035, 0.11, uWaterWind);
            float glint = exp(-dot(miss, miss) / (2.0 * spread));
            float reach = smoothstep(8.0, 65.0, distance(vWaterFacetCenter.xz, cameraPosition.xz));
            float highlight = glint * mix(0.08, 0.24, reach) * uWaterLightStrength * uWaterAbove;
            vec3 reflectionTint = mix(outgoingLight, uWaterLightColor * facetPalette * 0.65, 0.65);
            outgoingLight = mix(outgoingLight, reflectionTint, highlight);

            // White water belongs to moving crests, distinct from the reflected road of light.
            // Continuous surface coordinates keep it coherent across different facet budgets.
            float swellCrest = sin(vWaterSurface.x * 0.15 + uWaterTime * 1.3) * 0.35
              + cos(vWaterSurface.z * 0.2 + uWaterTime * 0.9) * 0.25;
            float crestFoam = smoothstep(0.26, 0.53, swellCrest) * uWaterFoamStrength;
            float rogueOffset = (vWaterSurface.x - uWaterRogue.x) * uWaterRogue.z - 0.55;
            float rogueFoam = exp(-rogueOffset * rogueOffset / 2.0)
              * smoothstep(0.25, 2.0, uWaterRogue.y)
              * (1.0 - smoothstep(34.0, 46.0, vWaterSurface.z));
            float foamNoise = sin(vWaterSurface.x * 1.35 + vWaterSurface.z * 0.7 - uWaterTime * 0.45)
              * cos(vWaterSurface.z * 1.6 - vWaterSurface.x * 0.4 + uWaterTime * 0.3);
            float foamAA = max(fwidth(foamNoise), 0.025);
            float foamLace = smoothstep(-0.05 - foamAA, 0.40 + foamAA, foamNoise);
            float foam = clamp(max(crestFoam, rogueFoam) * foamLace * uWaterAbove, 0.0, 0.85);
            vec3 foamTint = mix(vec3(0.74, 0.87, 0.87), vec3(0.94, 0.97, 0.91), clamp(waterNormal.y, 0.0, 1.0));
            outgoingLight = mix(outgoingLight, foamTint * uWaterFoamLight, foam);
            diffuseColor.a = min(0.94, diffuseColor.a + foam * 0.18);
          }
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    return 'deepbreath-water-facets-v7';
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
    uniforms.uWaterFoamStrength.value = whitecapStrength(mapWaves, weather?.wind ?? 0);
    uniforms.uWaterFoamLight.value = THREE.MathUtils.clamp(
      (0.16 + lighting.ambientIntensity * 0.25 + lighting.sunIntensity * 0.12)
        * THREE.MathUtils.lerp(1, 0.35, lighting.nightMix) * (1 - (weather?.cloud ?? 0) * 0.35),
      0.035, 0.9,
    );
    uniforms.uWaterAbove.value = THREE.MathUtils.smoothstep(cameraY, -0.65, 0.9);
    uniforms.uWaterSky.value.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    uniforms.uWaterHorizon.value.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    uniforms.uWaterLightDirection.value.set(...lighting.direction).normalize();
    uniforms.uWaterLightStrength.value = reflectionStrength(lighting.sunIntensity, lighting.nightMix, weather?.cloud ?? 0);
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
