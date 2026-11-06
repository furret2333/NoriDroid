/**
 * 深海场景：单次全屏着色 + 一次粒子绘制，不依赖外部模型或贴图。
 * 独立于 Live2D 画布；调用方负责可见性、触摸过滤和失败回退。
 */
import {frameGate, frameThreshold} from "./live2d/frameCap"

const BACKGROUND_VERTEX = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`

const BACKGROUND_FRAGMENT = `
precision mediump float;
varying vec2 vUv;
uniform float uTime;
uniform vec2 uResolution;
void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec3 col = mix(vec3(0.008, 0.024, 0.067), vec3(0.025, 0.115, 0.18), smoothstep(0.08, 1.0, uv.y));
  float surface = smoothstep(0.58, 1.0, uv.y);
  col += vec3(0.018, 0.075, 0.082) * surface;
  // 两条低频流光叠加，模拟水体折射；不使用噪声纹理或额外渲染通道。
  float flow = sin(uv.x * 6.0 + uv.y * 2.2 + uTime * 0.065)
             * sin(uv.x * 3.3 - uv.y * 3.8 - uTime * 0.042);
  float flowMask = smoothstep(0.12, 0.65, uv.y) * (1.0 - smoothstep(0.92, 1.0, uv.y));
  col += vec3(0.003, 0.018, 0.022) * (flow * 0.5 + 0.5) * flowMask;
  float shimmer = sin(uv.x * 12.0 + uTime * 0.23) * sin(uv.x * 6.0 - uTime * 0.14);
  shimmer = max(shimmer, 0.0);
  col += vec3(0.014, 0.05, 0.058) * shimmer * shimmer * smoothstep(0.84, 1.0, uv.y);
  float beams = 0.0;
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float center = 0.17 + fi * 0.22 + sin(uTime * 0.035 + fi * 2.3) * 0.035;
    float slope = (fi - 1.5) * 0.06;
    float width = 0.025 + (1.0 - uv.y) * 0.075;
    float dx = abs(uv.x - center - slope * (1.0 - uv.y));
    float beam = 1.0 - smoothstep(width * 0.15, width, dx);
    beams += beam * (0.65 + 0.35 * sin(uTime * 0.055 + fi * 1.7));
  }
  col += vec3(0.018, 0.075, 0.086) * beams * smoothstep(0.05, 0.95, uv.y);
  // 底部透视网格，逐渐隐入远处的雾中。
  float horizon = 0.29;
  if (uv.y < horizon) {
    float depth = horizon - uv.y;
    float perspective = 0.05 / (depth + 0.045);
    float gx = (uv.x - 0.5) * aspect * perspective * 120.0;
    float gy = perspective * 18.0 + uTime * 0.055;
    // 根据画布像素估计线条宽度并淡出密集区域，避免透视远端细网格闪烁。
    float pxX = 120.0 * aspect * perspective / max(uResolution.x, 1.0);
    float pxY = 0.9 / ((depth + 0.045) * (depth + 0.045) * max(uResolution.y, 1.0));
    float lineX = 1.0 - smoothstep(0.008, 0.025 + min(pxX, 0.12), abs(fract(gx + 0.5) - 0.5));
    float lineY = 1.0 - smoothstep(0.008, 0.025 + min(pxY, 0.12), abs(fract(gy + 0.5) - 0.5));
    lineX *= 1.0 - smoothstep(0.07, 0.3, pxX);
    lineY *= 1.0 - smoothstep(0.07, 0.3, pxY);
    float fade = smoothstep(0.0, 0.065, depth) * (0.38 + 0.62 * depth / horizon);
    col += vec3(0.025, 0.14, 0.17) * max(lineX, lineY) * fade;
  }
  float vignette = 1.0 - 0.3 * smoothstep(0.25, 0.85, length((uv - 0.5) * vec2(aspect, 1.0)));
  gl_FragColor = vec4(col * vignette, 1.0);
}`

const PARTICLE_VERTEX = `
attribute vec4 aSeed;
uniform float uTime;
uniform float uPixelRatio;
uniform vec2 uTouch;
uniform float uTouchStrength;
varying float vAlpha;
varying float vHue;
void main() {
  vec2 p = vec2(fract(aSeed.x + uTime * (0.0015 + aSeed.z * 0.002)),
                fract(aSeed.y + uTime * (0.002 + aSeed.w * 0.003)));
  p.x += sin(uTime * 0.16 + aSeed.y * 23.0) * 0.012;
  vec2 delta = uTouch - p;
  float influence = (1.0 - smoothstep(0.0, 0.35, length(delta))) * uTouchStrength;
  p += delta * influence * 0.09;
  float twinkle = 0.65 + 0.35 * sin(uTime * (0.5 + aSeed.w) + aSeed.x * 30.0);
  vAlpha = (0.18 + aSeed.z * 0.38) * twinkle;
  vHue = aSeed.w;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  // 少量较大的柔光点给粒子层增加远近，数量与 draw call 均保持不变。
  gl_PointSize = (1.5 + aSeed.z * 3.2 + step(0.96, aSeed.z) * 3.0) * uPixelRatio;
}`

const PARTICLE_FRAGMENT = `
precision mediump float;
varying float vAlpha;
varying float vHue;
void main() {
  float r = length(gl_PointCoord - vec2(0.5));
  float glow = 1.0 - smoothstep(0.0, 0.5, r);
  vec3 color = mix(vec3(0.35, 0.78, 0.95), vec3(0.58, 0.96, 0.87), vHue);
  gl_FragColor = vec4(color, glow * glow * vAlpha);
}`

export type DeepseaQuality = "balanced" | "fine"

export interface DeepseaBg {
  start(): void
  pause(): void
  resize(scale: number): void
  setFps(fps: number): void
  setQuality(quality: DeepseaQuality): void
  touchStart(x: number, y: number): void
  touchMove(x: number, y: number): void
  touchEnd(): void
  destroy(): void
}

/** start 在 WebGL 不可用或着色器初始化失败时同步抛错；上下文丢失时调用 onFailure。 */
export const createDeepseaBg = (canvas: HTMLCanvasElement, onFailure: () => void): DeepseaBg => {
  let gl: WebGLRenderingContext | null = null
  let background: WebGLProgram | null = null
  let particle: WebGLProgram | null = null
  let quad: WebGLBuffer | null = null
  let points: WebGLBuffer | null = null
  let locations: {
    position: number; seed: number
    bgTime: WebGLUniformLocation | null; resolution: WebGLUniformLocation | null
    pointTime: WebGLUniformLocation | null; pixelRatio: WebGLUniformLocation | null
    touch: WebGLUniformLocation | null; touchStrength: WebGLUniformLocation | null
  } | null = null
  let raf = 0
  let running = false
  let destroyed = false
  let failed = false
  // Keep the user's value, not the current quality's cap: increasing quality
  // must restore the requested scale and frame rate without another UI change.
  let scale = 1
  let fps = 60
  let quality: DeepseaQuality = "balanced"
  let pixelRatio = 1
  let interval = frameThreshold(30)
  let lastDraw: number | undefined
  let lastFrame: number | undefined
  let elapsed = 0
  let touchX = 0.5
  let touchY = 0.5
  let smoothX = 0.5
  let smoothY = 0.5
  let touchStrength = 0
  let touchDown = false
  const maxCount = 240

  const updateFps = (): void => {
    const cap = quality === "fine" ? 60 : 30
    interval = frameThreshold(Number.isFinite(fps) && fps > 0 ? Math.min(fps, cap) : cap)
    lastDraw = undefined
  }

  const pause = (): void => {
    running = false
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    lastDraw = undefined
    lastFrame = undefined
  }
  const cleanResources = (): void => {
    if (gl) {
      if (quad) gl.deleteBuffer(quad)
      if (points) gl.deleteBuffer(points)
      if (background) gl.deleteProgram(background)
      if (particle) gl.deleteProgram(particle)
    }
    quad = points = null
    background = particle = null
    locations = null
  }
  const contextLost = (event: Event): void => {
    event.preventDefault() // Allow the browser to restore this canvas for a later retry.
    if (destroyed || failed) return
    failed = true
    pause()
    onFailure()
  }
  const compileProgram = (vertex: string, fragment: string): WebGLProgram => {
    const context = gl!
    const shaders: WebGLShader[] = []
    let program: WebGLProgram | null = null
    try {
      for (const [type, source] of [[context.VERTEX_SHADER, vertex], [context.FRAGMENT_SHADER, fragment]] as const) {
        const shader = context.createShader(type)
        if (!shader) throw new Error("无法创建深海着色器")
        shaders.push(shader)
        context.shaderSource(shader, source)
        context.compileShader(shader)
        if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) throw new Error(`深海着色器编译失败: ${context.getShaderInfoLog(shader) || "unknown"}`)
      }
      program = context.createProgram()
      if (!program) throw new Error("无法创建深海渲染程序")
      shaders.forEach(shader => context.attachShader(program!, shader))
      context.linkProgram(program)
      if (!context.getProgramParameter(program, context.LINK_STATUS)) throw new Error(`深海渲染程序链接失败: ${context.getProgramInfoLog(program) || "unknown"}`)
      return program
    } catch (error) {
      if (program) context.deleteProgram(program)
      throw error
    } finally {
      shaders.forEach(shader => context.deleteShader(shader))
    }
  }
  const resize = (nextScale: number): void => {
    if (destroyed) return
    scale = Number.isFinite(nextScale) && nextScale > 0 ? Math.min(3, Math.max(0.5, nextScale)) : 1
    const width = Math.max(1, canvas.clientWidth || window.innerWidth || 1)
    const height = Math.max(1, canvas.clientHeight || window.innerHeight || 1)
    // 限制 GPU 的视口尺寸，避免非常长的屏幕产生无效画布。
    const maxDimension = gl ? gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number : 4096
    pixelRatio = Math.min(scale, quality === "fine" ? 2 : 1.5, maxDimension / width, maxDimension / height)
    const w = Math.max(1, Math.round(width * pixelRatio))
    const h = Math.max(1, Math.round(height * pixelRatio))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    gl?.viewport(0, 0, w, h)
  }
  const initialize = (): void => {
    if (gl) return
    gl = canvas.getContext("webgl", {alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "low-power"})
    if (!gl) throw new Error("设备不支持深海背景所需的 WebGL")
    if (gl.isContextLost()) {
      gl = null
      throw new Error("深海背景图形上下文正在恢复，请稍后重试")
    }
    canvas.addEventListener("webglcontextlost", contextLost)
    try {
      background = compileProgram(BACKGROUND_VERTEX, BACKGROUND_FRAGMENT)
      particle = compileProgram(PARTICLE_VERTEX, PARTICLE_FRAGMENT)
      locations = {
        position: gl.getAttribLocation(background, "aPosition"),
        seed: gl.getAttribLocation(particle, "aSeed"),
        bgTime: gl.getUniformLocation(background, "uTime"),
        resolution: gl.getUniformLocation(background, "uResolution"),
        pointTime: gl.getUniformLocation(particle, "uTime"),
        pixelRatio: gl.getUniformLocation(particle, "uPixelRatio"),
        touch: gl.getUniformLocation(particle, "uTouch"),
        touchStrength: gl.getUniformLocation(particle, "uTouchStrength"),
      }
      if (locations.position < 0 || locations.seed < 0) throw new Error("深海背景着色器属性不可用")
      quad = gl.createBuffer()
      points = gl.createBuffer()
      if (!quad || !points) throw new Error("无法创建深海背景缓冲区")
      gl.bindBuffer(gl.ARRAY_BUFFER, quad)
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
      // Allocate once; changing quality only changes the number drawn.
      const seeds = new Float32Array(maxCount * 4)
      for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random()
      gl.bindBuffer(gl.ARRAY_BUFFER, points)
      gl.bufferData(gl.ARRAY_BUFFER, seeds, gl.STATIC_DRAW)
      resize(scale)
      if (gl.getError() !== gl.NO_ERROR) throw new Error("深海背景图形资源初始化失败")
    } catch (error) {
      cleanResources()
      canvas.removeEventListener("webglcontextlost", contextLost)
      gl = null
      throw error
    }
  }
  const draw = (now: number): void => {
    raf = 0
    if (!running || !gl || !background || !particle || !quad || !points || !locations || destroyed) return
    if (!Number.isFinite(now)) { raf = requestAnimationFrame(draw); return }
    const gate = frameGate(now, lastDraw, interval)
    lastDraw = gate.last
    if (!gate.draw) { raf = requestAnimationFrame(draw); return }
    const dt = lastFrame === undefined ? 0 : Math.max(0, Math.min((now - lastFrame) / 1000, 0.15))
    lastFrame = now
    elapsed = (elapsed + dt) % 4096
    const targetStrength = touchDown ? 1 : 0
    const speed = touchDown ? 1 / 0.35 : 1 / 0.4
    touchStrength += Math.max(-speed * dt, Math.min(speed * dt, targetStrength - touchStrength))
    const follow = 1 - Math.exp(-dt * 8)
    smoothX += (touchX - smoothX) * follow
    smoothY += (touchY - smoothY) * follow
    const context = gl
    context.disable(context.BLEND)
    context.useProgram(background)
    context.bindBuffer(context.ARRAY_BUFFER, quad)
    const position = locations.position
    context.enableVertexAttribArray(position)
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0)
    context.uniform1f(locations.bgTime, elapsed)
    context.uniform2f(locations.resolution, canvas.width, canvas.height)
    context.drawArrays(context.TRIANGLES, 0, 3)
    context.disableVertexAttribArray(position)
    context.enable(context.BLEND)
    context.blendFunc(context.SRC_ALPHA, context.ONE)
    context.useProgram(particle)
    context.bindBuffer(context.ARRAY_BUFFER, points)
    const seed = locations.seed
    context.enableVertexAttribArray(seed)
    context.vertexAttribPointer(seed, 4, context.FLOAT, false, 0, 0)
    context.uniform1f(locations.pointTime, elapsed)
    context.uniform1f(locations.pixelRatio, pixelRatio)
    context.uniform2f(locations.touch, smoothX, smoothY)
    context.uniform1f(locations.touchStrength, touchStrength)
    context.drawArrays(context.POINTS, 0, quality === "fine" ? maxCount : 150)
    context.disableVertexAttribArray(seed)
    raf = requestAnimationFrame(draw)
  }
  const setTouch = (x: number, y: number): void => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const rect = canvas.getBoundingClientRect()
    if (!(rect.width > 0 && rect.height > 0)) return
    touchX = Math.max(0, Math.min(1, (x - rect.left) / rect.width))
    touchY = 1 - Math.max(0, Math.min(1, (y - rect.top) / rect.height))
  }
  return {
    start(): void {
      if (destroyed || failed || running) return
      initialize()
      running = true
      lastDraw = undefined
      lastFrame = undefined
      raf = requestAnimationFrame(draw)
    },
    pause,
    resize,
    setFps(value): void {
      fps = value
      updateFps()
    },
    setQuality(value): void {
      if (destroyed) return
      quality = value === "fine" ? "fine" : "balanced"
      updateFps()
      resize(scale)
    },
    touchStart(x, y): void { setTouch(x, y); touchDown = true },
    touchMove(x, y): void { if (touchDown) setTouch(x, y) },
    touchEnd(): void { touchDown = false },
    destroy(): void {
      if (destroyed) return
      pause()
      destroyed = true
      canvas.removeEventListener("webglcontextlost", contextLost)
      cleanResources()
      canvas.width = 1
      canvas.height = 1
      gl = null
    },
  }
}
