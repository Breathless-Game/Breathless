import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';
import { WATER_WAVES_GLSL } from './water-waves';

/** Continuous waves with an illustrated, flat-face blue/green palette. */
export class WaterSurfaceMaterial extends THREE.MeshStandardMaterial {
  private readonly dayWater = new THREE.Color('#287f96');
  private readonly nightWater = new THREE.Color('#133346');
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
      color: '#287f96', flatShading: true, roughness: 0.7, metalness: 0,
      transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide,
    });
    this.forceSinglePass = true;
    this.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.waterUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterWorldPosition;
          flat varying vec2 vWaterPigment;
          uniform float uWaterTime;
          uniform float uWaterWind;
          uniform float uWaterMapWaves;
          uniform float uWaterDetail;
          ${WATER_WAVES_GLSL}
        `)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          // Flat interpolation keeps the illustrated pigment within triangle
          // edges while indexed neighboring faces can share a color patch.
          // The spatial field is fixed, so wave motion never flickers colors.
          vWaterPigment = vec2(
            sin(dot(position.xz, vec2(0.71, 0.47))),
            sin(dot(position.xz, vec2(-0.39, 0.63)) + 1.7));
          transformed.y += waterWaveHeight(position.xz, uWaterTime, uWaterDetail)
            * (1.0 + uWaterWind * 0.75) * uWaterMapWaves;
        `)
        .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
          vWaterWorldPosition = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          varying vec3 vWaterWorldPosition;
          flat varying vec2 vWaterPigment;
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
        .replace('#include <lights_physical_fragment>', `
          // The geometric face normal is constant across each triangle. Let
          // that slope select a blue/green pigment before scene lighting, so
          // facets remain legible away from the sun's narrow reflection path.
          // Smooth palette transitions avoid colors popping as a wave turns.
          vec3 facetNormal = inverseTransformDirection(normal, viewMatrix);
          facetNormal *= facetNormal.y < 0.0 ? -1.0 : 1.0;
          vec2 facetSlope = facetNormal.xz / max(facetNormal.y, 0.2);
          float facetTone = smoothstep(-0.07, 0.07,
            dot(facetSlope, vec2(-0.65, 0.76)));
          float facetHue = smoothstep(-0.065, 0.065,
            dot(facetSlope, vec2(0.76, 0.65)));
          vec3 facetShade = mix(vec3(0.54, 0.68, 0.86),
            vec3(1.36, 1.31, 1.07), facetTone);
          facetShade *= mix(vec3(0.85, 1.04, 1.03),
            vec3(1.09, 1.01, 0.93), facetHue);
          facetShade *= 1.0 + vWaterPigment.x * 0.30;
          facetShade *= mix(vec3(0.79, 1.01, 1.10),
            vec3(1.16, 1.07, 0.91), vWaterPigment.y * 0.5 + 0.5);
          diffuseColor.rgb *= mix(vec3(1.0), facetShade,
            mix(0.5, 1.0, uWaterAbove));
          #include <lights_physical_fragment>
        `)
        .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
          // One celestial lobe below. Diffuse/hemisphere light still uses
          // Three's derivative normal of the displaced triangle.
          reflectedLight.directSpecular = vec3(0.0);
        `)
        .replace('#include <opaque_fragment>', `
          if (uWaterEffects > 0.5) {
            vec3 waterNormal = inverseTransformDirection(normal, viewMatrix);
            vec3 waterView = normalize(cameraPosition - vWaterWorldPosition);
            float facing = clamp(dot(waterNormal, waterView), 0.0, 1.0);
            float fresnel = 0.02 + 0.98 * pow(1.0 - facing, 5.0);
            vec3 reflectedView = reflect(-waterView, waterNormal);
            // Neighboring faces reflect the same sky at different angles.
            // Color boundaries follow slopes instead of random tint.
            vec3 skyReflection = mix(uWaterHorizon, uWaterSky,
              smoothstep(0.0, 0.55, max(reflectedView.y, 0.0)));
            outgoingLight = mix(outgoingLight, skyReflection * 0.20,
              fresnel * 0.27 * uWaterAbove);

            // Per-pixel view attaches light to the moving surface. Flat normals
            // naturally break the reflected disc's contour at triangle edges.
            float alignment = max(dot(reflectedView, uWaterLightDirection), 0.0);
            float sharpness = mix(600.0, 1000.0, uWaterDetail * 0.5) * mix(1.0, 0.72, uWaterWind);
            float glint = pow(alignment, sharpness);
            float halo = pow(alignment, 28.0) * 0.025;
            float reflection = (glint + halo) * (0.25 + fresnel * 0.75)
              * uWaterLightStrength * uWaterAbove;
            outgoingLight += uWaterLightColor * reflection;
            // Absorb distant seabed silhouettes above water; ease into a
            // translucent underside as the camera crosses the waterline.
            diffuseColor.a = min(1.0, diffuseColor.a + fresnel * 0.06 * uWaterAbove);
          }
          #include <opaque_fragment>
        `);
    };
  }

  customProgramCacheKey(): string {
    return 'deepbreath-water-facet-palette-v3';
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
    uniforms.uWaterLightStrength.value = Math.min(1.8, lighting.sunIntensity * 0.85)
      * (1 - (weather?.cloud ?? 0) * 0.93);
    this.color.copy(this.dayWater).lerp(this.nightWater, lighting.nightMix);
    this.opacity = THREE.MathUtils.lerp(0.30, 1.0, uniforms.uWaterAbove.value);
  }
}
