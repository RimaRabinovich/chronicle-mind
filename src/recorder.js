/**
 * recorder.js
 * Wraps MediaRecorder + Web Audio API for recording and real-time waveform drawing.
 */
export class AudioRecorder {
  constructor(canvasEl) {
    this.canvas      = canvasEl;
    this.ctx         = canvasEl.getContext('2d');
    this.mediaRecorder = null;
    this.audioCtx    = null;
    this.analyser    = null;
    this.chunks      = [];
    this.rafId       = null;
    this.isRecording = false;
    this._drawIdle(); // draw flat line initially
  }

  /** Start recording — returns the MediaStream */
  async start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

    // Audio analysis
    this.audioCtx = new AudioContext();
    const src = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    src.connect(this.analyser);

    // MediaRecorder
    const mimeType = this._bestMime();
    this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(100);
    this.isRecording = true;

    this._animate();
    return stream;
  }

  /** Stop recording — returns the audio Blob */
  stop() {
    return new Promise((resolve) => {
      this.mediaRecorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: this.mediaRecorder.mimeType });
        resolve(blob);
      };
      // Stop all tracks
      this.mediaRecorder.stream.getTracks().forEach(t => t.stop());
      this.mediaRecorder.stop();

      // Cleanup
      if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
      if (this.rafId)    { cancelAnimationFrame(this.rafId); this.rafId = null; }
      this.isRecording = false;
      this._drawIdle();
    });
  }

  _bestMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
  }

  _animate() {
    const canvas   = this.canvas;
    const ctx      = this.ctx;
    const analyser = this.analyser;
    const buf      = analyser.frequencyBinCount;
    const data     = new Uint8Array(buf);

    const dpr = window.devicePixelRatio || 1;
    canvas.width  = canvas.offsetWidth  * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    ctx.scale(dpr, dpr);
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;

    const draw = () => {
      this.rafId = requestAnimationFrame(draw);
      analyser.getByteTimeDomainData(data);

      ctx.clearRect(0, 0, W, H);

      // Gradient stroke
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0,   '#6d28d9');
      grad.addColorStop(0.5, '#a78bfa');
      grad.addColorStop(1,   '#6d28d9');

      ctx.lineWidth   = 2;
      ctx.strokeStyle = grad;
      ctx.shadowBlur  = 10;
      ctx.shadowColor = 'rgba(139,92,246,0.7)';

      ctx.beginPath();
      const sliceW = W / buf;
      let x = 0;
      for (let i = 0; i < buf; i++) {
        const v = data[i] / 128.0;
        const y = (v * H) / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceW;
      }
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    };
    draw();
  }

  _drawIdle() {
    const canvas = this.canvas;
    const ctx    = this.ctx;
    const dpr    = window.devicePixelRatio || 1;

    // Only resize if canvas has layout dimensions
    if (canvas.offsetWidth > 0) {
      canvas.width  = canvas.offsetWidth  * dpr;
      canvas.height = canvas.offsetHeight * dpr;
      ctx.scale(dpr, dpr);
    }
    const W = canvas.offsetWidth  || 370;
    const H = canvas.offsetHeight || 80;

    ctx.clearRect(0, 0, W, H);
    const grad = ctx.createLinearGradient(0, 0, W, 0);
    grad.addColorStop(0,   'rgba(109,40,217,0.08)');
    grad.addColorStop(0.5, 'rgba(167,139,250,0.2)');
    grad.addColorStop(1,   'rgba(109,40,217,0.08)');

    ctx.lineWidth   = 1.5;
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();
  }
}
