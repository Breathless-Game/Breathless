import * as THREE from 'three';
import type { LightingState } from './daylight';
import type { RenderQuality } from './render-quality';
import type { WeatherState } from './weather';

/** Periodic fractal density generated once; cloud animation only moves UVs. */
function cloudNoise(): THREE.DataTexture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number) => {
    let n = Math.imul(x + 341, 374761393) ^ Math.imul(y + 791, 668265263);
    n = Math.imul(n ^ n >>> 13, 1274126177);
    return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number, period: number) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = hash(ix % period, iy % period);
    const b = hash((ix + 1) % period, iy % period);
    const c = hash(ix % period, (iy + 1) % period);
    const d = hash((ix + 1) % period, (iy + 1) % period);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let density = 0, weight = 0, amplitude = 1;
      for (let octave = 0; octave < 6; octave++) {
        const frequency = 4 * 2 ** octave;
        density += noise(x / size * frequency, y / size * frequency, frequency) * amplitude;
        weight += amplitude;
        amplitude *= 0.53;
      }
      const i = (y * size + x) * 4;
      data[i] = Math.round(density / weight * 255);
      data[i + 1] = Math.round(noise(x / size * 32, y / size * 32, 32) * 255);
      data[i + 2] = Math.round(noise(x / size * 16, y / size * 16, 16) * 255);
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** One sky draw, no reflection cameras, render targets, or per-frame textures. */
export class Atmosphere extends THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  constructor() {
    const material = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uCloudNoise: { value: cloudNoise() },
        uSky: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uLightColor: { value: new THREE.Color() },
        uSunDirection: { value: new THREE.Vector3() },
        uMoonDirection: { value: new THREE.Vector3() },
        uCloudOffset: { value: new THREE.Vector2() },
        uCloudCover: { value: 0 },
        uStorm: { value: 0 },
        uNight: { value: 0 },
        uDetail: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vSkyDirection;
        void main() {
          vSkyDirection = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_Position.z = gl_Position.w;
        }
      `,
      fragmentShader: /* glsl */`
        #include <common>
        varying vec3 vSkyDirection;
        uniform sampler2D uCloudNoise;
        uniform vec3 uSky;
        uniform vec3 uHorizon;
        uniform vec3 uLightColor;
        uniform vec3 uSunDirection;
        uniform vec3 uMoonDirection;
        uniform vec2 uCloudOffset;
        uniform float uCloudCover;
        uniform float uStorm;
        uniform float uNight;
        uniform float uDetail;

        float starHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }

        void main() {
          vec3 viewDirection = normalize(vSkyDirection);
          float height = pow(clamp((viewDirection.y + 0.025) / 0.6, 0.0, 1.0), 0.46);
          vec3 zenith = uSky * mix(vec3(0.52, 0.70, 0.88), vec3(0.65), uNight);
          vec3 sky = mix(uHorizon, zenith, height);

          float sunDistance = length(viewDirection - uSunDirection);
          float moonDistance = length(viewDirection - uMoonDirection);
          float sunUp = smoothstep(-0.03, 0.045, uSunDirection.y);
          float moonUp = smoothstep(-0.025, 0.045, uMoonDirection.y);
          float horizonFade = smoothstep(-0.015, 0.035, viewDirection.y);
          // Broad aerosol scattering gathers around the actual celestial
          // source. A small core and diffuse halo avoid a flat painted disc.
          float warmHorizon = (1.0 - smoothstep(0.02, 0.24, uSunDirection.y)) * sunUp;
          sky += vec3(0.28, 0.065, 0.016) * exp(-sunDistance * 2.8) * warmHorizon;
          vec3 sunColor = mix(vec3(1.0, 0.44, 0.13), uLightColor, smoothstep(0.0, 0.2, uSunDirection.y));
          float sunCore = 1.0 - smoothstep(0.0105, 0.0125, sunDistance);
          float sunHalo = 0.16 * exp(-sunDistance * 22.0) + 0.035 * exp(-sunDistance * 4.5);
          sky += sunColor * (sunCore * 3.0 + sunHalo) * sunUp * horizonFade;

          float moonRadius = moonDistance / 0.012;
          float moonCore = 1.0 - smoothstep(0.0105, 0.012, moonDistance);
          float moonRelief = mix(0.63, 1.0, sqrt(max(0.0, 1.0 - moonRadius * moonRadius)));
          sky += vec3(0.65, 0.76, 0.95) * (moonCore * moonRelief * 1.5 + 0.025 * exp(-moonDistance * 22.0))
            * moonUp * uNight * horizonFade;

          if (uDetail > 0.5 && uNight > 0.05) {
            vec2 starPoint = viewDirection.xz / max(viewDirection.y + 0.5, 0.1) * 220.0;
            vec2 cell = floor(starPoint);
            vec2 local = fract(starPoint) - vec2(starHash(cell + 4.7), starHash(cell + 8.1));
            float star = (1.0 - smoothstep(0.035, 0.12, length(local))) * step(0.994, starHash(cell));
            sky += vec3(0.38, 0.47, 0.60) * star * uNight * horizonFade;
          }

          // Project a cloud deck above the horizon, producing perspective
          // compression near the water. Two texture reads on low quality;
          // higher tiers add a fine veil and edge detail, not a noise loop.
          vec2 cloudUv = viewDirection.xz / max(viewDirection.y + 0.16, 0.055) * vec2(0.19, 0.13) + uCloudOffset;
          vec2 densityNoise = texture2D(uCloudNoise, cloudUv).rg;
          if (uDetail > 1.5) densityNoise.r += (texture2D(uCloudNoise, cloudUv * 2.9).g - 0.5) * 0.035;
          float threshold = mix(0.69, 0.20, uCloudCover);
          float density = smoothstep(threshold, threshold + 0.19, densityNoise.r - densityNoise.g * 0.055);
          float shadow = texture2D(uCloudNoise, cloudUv + uSunDirection.xz * 0.023).r;
          float silver = clamp((densityNoise.r - shadow) * 7.0 + 0.36, 0.0, 1.0);
          vec3 cloudShade = mix(vec3(0.43, 0.51, 0.58), vec3(0.035, 0.055, 0.095), uNight);
          vec3 cloudLight = mix(vec3(0.90, 0.92, 0.93) * mix(vec3(1.0), uLightColor, 0.22), vec3(0.11, 0.15, 0.22), uNight);
          vec3 clouds = mix(cloudShade, cloudLight, silver) * (1.0 - uStorm * 0.46);
          clouds += sunColor * exp(-sunDistance * 8.0) * density * (1.0 - density) * sunUp * 0.5;
          float cloudOpacity = density * mix(0.76, 0.97, uCloudCover) * horizonFade;
          sky = mix(sky, clouds, cloudOpacity);
          if (uDetail > 0.5) {
            float veil = texture2D(uCloudNoise, cloudUv * vec2(0.7, 2.4) + vec2(0.3, 0.17) - uCloudOffset * 0.35).b;
            veil = smoothstep(0.60, 0.91, veil) * (0.10 + uCloudCover * 0.12) * horizonFade;
            sky = mix(sky, cloudLight, veil);
          }
          gl_FragColor = vec4(max(sky, vec3(0.0)), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    super(new THREE.SphereGeometry(180, 24, 12), material);
    this.frustumCulled = false;
    this.renderOrder = -100;
  }

  update(lighting: LightingState, weather: WeatherState, cameraY: number, cameraX: number, time: number, quality: RenderQuality): void {
    this.visible = cameraY > 0;
    if (!this.visible) return;
    this.position.set(cameraX, cameraY, 22);
    const uniforms = this.material.uniforms;
    uniforms.uSky.value.setRGB(...lighting.skyColor, THREE.SRGBColorSpace);
    uniforms.uHorizon.value.setRGB(...lighting.horizonColor, THREE.SRGBColorSpace);
    uniforms.uLightColor.value.setRGB(...lighting.lightColor, THREE.SRGBColorSpace);
    uniforms.uSunDirection.value.set(...lighting.sunDirection);
    uniforms.uMoonDirection.value.set(...lighting.moonDirection);
    // time is the world's integrated cloud clock; changing weather adjusts its
    // speed upstream, so selecting a preset cannot jump the cloud positions.
    uniforms.uCloudOffset.value.set(time * 0.0015, time * 0.00035);
    uniforms.uCloudCover.value = weather.cloud;
    uniforms.uStorm.value = weather.storm;
    uniforms.uNight.value = lighting.nightMix;
    uniforms.uDetail.value = quality.skyDetail;
  }
}
