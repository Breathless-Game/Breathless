import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';

/** Colored low-poly facets and broken celestial highlights in one water draw. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#367f91');
  private readonly nightWater = new THREE.Color('#17364d');
  private readonly waterUniforms = {
    uWaterTime: { value: 0 },
    uWaterEffects: { value: 1 },
    uWaterDetail: { value: 1 },
    uWaterWind: { value: 0 },
    uWaterMapWaves: { value: 1 },
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
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Shared corners evaluate the same two waves on the GPU. No per-frame
          // geometry upload or CPU normal rebuild is needed at any quality.
          transformed.y += (sin(position.x * 0.15 + uWaterTime * 1.3) * 0.35
            + cos(position.z * 0.2 + uWaterTime * 0.9) * 0.25)
            * (1.0 + uWaterWind * 0.75) * uWaterMapWaves;
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

            // Reflect each polygon's average view and normal. A broad source
            // path selects faces; sparse thresholds turn it into angular shards.
            vec3 waterHalf = normalize(waterView + uWaterLightDirection);
            float alignment = max(dot(waterNormal, waterHalf), 0.0);
            float reflectionPath = pow(alignment, 72.0);
            vec2 towardSource = normalize(uWaterLightDirection.xz);
            vec2 toFacet = vWaterFacetCenter.xz - cameraPosition.xz;
            float sourceDistance = max(0.0, dot(toFacet, towardSource));
            float acrossSource = abs(toFacet.x * towardSource.y - toFacet.y * towardSource.x);
            float laneWidth = (2.0 + sourceDistance * 0.075) * mix(1.6, 1.0, uWaterDetail * 0.5);
            float sourceLane = (1.0 - smoothstep(laneWidth * 0.4, laneWidth, acrossSource))
              * smoothstep(0.0, 4.0, sourceDistance);
            // A tapered path keeps the light readable on coarse geometry as
            // well. Individual facet slopes still vary its colored fragments.
            reflectionPath = max(reflectionPath, sourceLane * mix(0.58, 0.90, facetTone));
            float facetPulse = 0.5 + 0.5 * sin(uWaterTime * (0.65 + uWaterWind * 0.25)
              + vWaterFacetTone.y * 6.283 + vWaterFacetCenter.x * 0.13);
            float shard = smoothstep(0.34, 0.72, reflectionPath)
              * smoothstep(0.40, 0.64, vWaterFacetTone.y + facetPulse * 0.16);
            if (uWaterDetail > 0.5) {
              // Medium adds a gentler second family of colored faces.
              shard += smoothstep(0.12, 0.48, reflectionPath) * 0.20
                * smoothstep(0.68, 0.86, facetTone + facetPulse * 0.12);
            }
            if (uWaterDetail > 1.5) {
              // High adds sparse bright tips, still constant across each face.
              shard += pow(reflectionPath, 3.0) * smoothstep(0.88, 0.98, facetPulse) * 0.22;
            }
            // Slice an inset triangle into a short trapezoid or wedge. Thin
            // angular patches read as light on water instead of solid ice tiles.
            float inset = min(min(vWaterPatch.x, vWaterPatch.y), vWaterPatch.z);
            float edgeAA = max(fwidth(inset), 0.002);
            float polygon = smoothstep(0.045, 0.045 + edgeAA, inset);
            float bandCenter = 0.38 + vWaterFacetTone.x * 0.22;
            float bandDistance = abs(vWaterPatch.w - bandCenter);
            float bandWidth = mix(0.045, 0.09, uWaterDetail * 0.5);
            float bandAA = max(fwidth(vWaterPatch.w), 0.002);
            polygon *= 1.0 - smoothstep(bandWidth, bandWidth + bandAA, bandDistance);
            float highlight = clamp(shard * polygon * uWaterLightStrength * uWaterAbove, 0.0, 0.88);
            vec3 highlightColor = mix(uWaterLightColor * 0.70, vec3(1.0, 0.97, 0.86), 0.12);
            outgoingLight = mix(outgoingLight, max(outgoingLight, highlightColor), highlight);
            diffuseColor.a = clamp(diffuseColor.a + highlight * 0.08, 0.0, 0.9);
          }
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    return 'deepbreath-water-facets-v1';
  }

  setEffectsEnabled(enabled: boolean): void {
    this.waterUniforms.uWaterEffects.value = enabled ? 1 : 0;
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
