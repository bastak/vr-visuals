'use strict';
// Offline render: apply the effect chain to a video file with a hand-made eff_int timeline,
// frame by frame, without dropping frames (however slow the effects are).
// Loaded last; uses the globals of harness.js. Top-level names start with "off".
//
// 1. Record timeline: the video plays with effects bypassed (smooth) and the eff_int slider
//    is sampled against the video's own time. Save / load the timeline as JSON.
// 2. Render video: for every output frame, seek the video, set eff_int from the timeline, run
//    the chain (u_time = video time, so it's deterministic), encode with WebCodecs, mux to MP4
//    (mp4-muxer from jsdelivr, loaded on first use) and download it. No audio.
//
// Hooks in harness.js: offBusy (pauses the live loop while rendering) and offBypass (skips the
// effects while recording a timeline).

const OFF_MUXER_URL = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/build/mp4-muxer.mjs';
const OFF_BITRATE = 12e6;
const OFF_CODECS = ['avc1.640028', 'avc1.4D4028', 'avc1.42E028', 'avc1.640033', 'avc1.42001F'];

const OFF_AUDIO_RATE = 48000;
const OFF_AUDIO_STEP = 1024;      // soundtrack updates every 1024 samples (~21 ms), like a live frame
const OFF_AUDIO_BITRATE = 192000;

let offPoints = [];               // timeline: [[t, eff_int], ...], t increasing (seconds of video)
let offRecording = false, offRendering = false, offCancel = false, offPrevLoop = true;

function offStatus(msg) { $('offStatus').textContent = msg; }

function offVideoName() {
  const f = $('fileIn').files && $('fileIn').files[0];
  return f ? f.name.replace(/\.[^.]+$/, '') : 'video';
}

// A video file (not the webcam) is loaded and its length is known.
function offHasVideo() {
  return !camStream && !!video.currentSrc && video.readyState >= 1 && Number.isFinite(video.duration) && video.duration > 0;
}

// ---- timeline ----
function offAddPoint(t, v) {
  const last = offPoints[offPoints.length - 1];
  if (last && t <= last[0]) { if (t === last[0]) last[1] = v; return; }   // keep time increasing
  offPoints.push([t, v]);
}

// eff_int at video time t: linear between points, end values held.
function offCurveAt(t) {
  const p = offPoints;
  if (!p.length) return effInt;
  if (t <= p[0][0]) return p[0][1];
  if (t >= p[p.length - 1][0]) return p[p.length - 1][1];
  let lo = 0, hi = p.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = p[lo], [t1, v1] = p[hi];
  return v0 + (v1 - v0) * ((t - t0) / (t1 - t0));
}

function offDrawCurve() {
  const c = $('offCurve'), g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.fillStyle = '#111'; g.fillRect(0, 0, w, h);
  const dur = offHasVideo() ? video.duration : (offPoints.length ? offPoints[offPoints.length - 1][0] : 0);
  if (!dur) return;
  const x = (t) => (t / dur) * w, y = (v) => h - 2 - v * (h - 4);
  g.strokeStyle = '#8cf'; g.lineWidth = 1.5; g.beginPath();
  offPoints.forEach(([t, v], i) => (i ? g.lineTo(x(t), y(v)) : g.moveTo(x(t), y(v))));
  g.stroke();
  if (offHasVideo()) {   // playhead
    g.strokeStyle = '#f66'; g.beginPath();
    g.moveTo(x(video.currentTime), 0); g.lineTo(x(video.currentTime), h); g.stroke();
  }
}

async function offToggleRecording() {
  if (offRecording) { offStopRecording(); return; }
  if (offRendering) return;
  if (!offHasVideo()) { offStatus('load a video file first (Input: choose file)'); return; }
  if (autoBox.checked) { autoBox.checked = false; autoBox.onchange(); }   // the slider is the input
  offPoints = [];
  offRecording = true;
  offBypass = true;
  offPrevLoop = video.loop;
  video.loop = false;
  video.playbackRate = Number($('offSpeed').value) || 1;
  video.currentTime = 0;
  try { await video.play(); } catch (e) { /* already playing */ }
  $('offRecBtn').textContent = 'Stop';
  offStatus('recording: move the eff_int slider; it stops at the end of the video');
  const sample = () => {
    if (!offRecording) return;
    offAddPoint(video.currentTime, effInt);
    offDrawCurve();
    if (video.ended) { offStopRecording(); return; }
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

function offStopRecording() {
  if (!offRecording) return;
  offAddPoint(video.currentTime, effInt);
  offRecording = false;
  offBypass = false;
  video.loop = offPrevLoop;
  video.playbackRate = 1;
  if (video.ended) { video.currentTime = 0; video.play().catch(() => {}); }
  $('offRecBtn').textContent = 'Record timeline';
  const dur = offPoints.length ? offPoints[offPoints.length - 1][0] : 0;
  offStatus(`timeline: ${offPoints.length} points over ${dur.toFixed(1)} s`);
  offDrawCurve();
}

function offSaveTimeline() {
  if (!offPoints.length) { offStatus('nothing to save yet'); return; }
  const data = { version: 1, video: offVideoName(), duration: offHasVideo() ? video.duration : null,
                 points: offPoints.map(([t, v]) => [Number(t.toFixed(4)), Number(v.toFixed(4))]) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url; a.download = `timeline-${data.video}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function offLoadTimeline(file) {
  try {
    const data = JSON.parse(await file.text());
    const pts = (data.points || []).filter((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (!pts.length) throw new Error('no points in file');
    offPoints = [];
    for (const [t, v] of pts.sort((a, b) => a[0] - b[0])) offAddPoint(t, Math.min(1, Math.max(0, v)));
    offStatus(`loaded timeline: ${offPoints.length} points` + (data.video ? ` (made for "${data.video}")` : ''));
    offDrawCurve();
  } catch (e) {
    offStatus('cannot read timeline: ' + e.message);
  }
}

// ---- soundtrack for the timeline (reuses audio.js) ----
// The soundtrack's own graph is built on an OfflineAudioContext (audio.js buildAudioGraph) and
// driven by the normal updateSoundtrack() with eff_int from the timeline: the render pauses every
// OFF_AUDIO_STEP samples for one update. audio.js's state is swapped out for the render and put
// back afterwards. Head cues are left out (no head tracking offline). Call with offBusy set, so
// the live loop doesn't touch the swapped state.
async function offRenderSoundtrack(duration) {
  if (typeof buildAudioGraph !== 'function') throw new Error('the soundtrack code (audio.js) is not loaded');
  if (!folderHasFiles('bed')) await probeSoundtrack();
  if (!folderHasFiles('bed')) throw new Error('no soundtrack files (audio/bed/)');
  ensureAudioCtx();                                   // the live context decodes the files
  await preloadFolder('bed');
  await Promise.all(['peak', 'intense', 'head_appear', 'head_disappear'].map(preloadFolder));

  const saved = { audioCtx, masterGain, peakGain, peakSource, peakStopTimer, peakActive, peakHold, bedFilter,
    bedPanner, panLfo, panDepth, bedGain, calmBedGain, hotBedGain, calmBedSource, hotBedSource, playing,
    lastEffForAudio, lastIntenseLevel, presentHeads, readyAt: { ...readyAt }, getHeads };
  const frames = Math.max(OFF_AUDIO_STEP, Math.ceil(duration * OFF_AUDIO_RATE));
  const ctx = new OfflineAudioContext(2, frames, OFF_AUDIO_RATE);
  try {
    buildAudioGraph(ctx);
    calmBedSource = hotBedSource = peakSource = null;
    peakActive = false; peakHold = 0;
    let calmUrl = pickUrl('bed', (n) => !isMoreIntenseBed(n));
    const hotUrl = pickUrl('bed', isMoreIntenseBed);
    if (!calmUrl && !hotUrl) calmUrl = pickUrl('bed');
    const calmBuf = calmUrl && buffers.get(calmUrl), hotBuf = hotUrl && buffers.get(hotUrl);
    if (!calmBuf && !hotBuf) throw new Error('could not decode a bed file');
    if (calmBuf) calmBedSource = startLoop(calmBuf, calmBedGain);
    if (hotBuf) hotBedSource = startLoop(hotBuf, hotBedGain);
    silenceBedsNow();
    playing = true;
    for (const k of Object.keys(readyAt)) readyAt[k] = 0;
    presentHeads = new Map();
    getHeads = () => [];                              // no head cues offline
    const v0 = offCurveAt(0);
    lastEffForAudio = v0; lastIntenseLevel = intenseLevel(v0);
    applyAudioTargets(v0);
    const dt = OFF_AUDIO_STEP / OFF_AUDIO_RATE;
    for (let f = OFF_AUDIO_STEP; f < frames; f += OFF_AUDIO_STEP) {
      const t = f / OFF_AUDIO_RATE;
      ctx.suspend(t).then(() => {
        try { updateSoundtrack(offCurveAt(t), dt); } catch (e) { console.error(e); }
        ctx.resume().catch(() => { /* updateSoundtrack may already have resumed it */ });
      });
    }
    return await ctx.startRendering();
  } finally {
    clearTimeout(peakStopTimer);                      // a timer set during the render
    ({ audioCtx, masterGain, peakGain, peakSource, peakStopTimer, peakActive, peakHold, bedFilter, bedPanner,
       panLfo, panDepth, bedGain, calmBedGain, hotBedGain, calmBedSource, hotBedSource, playing,
       lastEffForAudio, lastIntenseLevel, presentHeads, getHeads } = saved);
    Object.assign(readyAt, saved.readyAt);
  }
}

// AudioBuffer -> 16-bit stereo WAV blob.
function offWav(buf) {
  const ch = Math.min(2, buf.numberOfChannels), n = buf.length, rate = buf.sampleRate;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * ch * 2, true); out.setUint16(32, ch * 2, true);
  out.setUint16(34, 16, true); str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, data[c][i]));
    out.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

function offDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return url;
}

async function offSoundtrackOnly() {
  if (offRendering) return;
  if (!offHasVideo()) { offStatus('load a video file first (Input: choose file)'); return; }
  if (!offPoints.length) { offStatus('record or load a timeline first'); return; }
  offRendering = true; offBusy = true;
  try {
    offStatus('rendering the soundtrack...');
    const buf = await offRenderSoundtrack(video.duration);
    const blob = offWav(buf);
    offDownload(blob, `vr-visuals-soundtrack-${offVideoName()}.wav`);
    window.offLastSoundtrack = buf;   // for checks
    offStatus(`saved vr-visuals-soundtrack-${offVideoName()}.wav (${buf.duration.toFixed(1)} s, ${(blob.size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    offStatus('soundtrack failed: ' + (e && e.message ? e.message : e));
  } finally {
    offRendering = false; offBusy = false;
  }
}

// Encode an AudioBuffer into the MP4 (AAC if this browser can encode it, else Opus).
async function offAudioCodec() {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate: OFF_AUDIO_RATE, numberOfChannels: 2, bitrate: OFF_AUDIO_BITRATE };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, mux }; } catch { /* next */ }
  }
  return null;
}

async function offEncodeAudio(buf, codec, muxer) {
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { err = e; } });
  enc.configure(codec.cfg);
  const block = 4800;   // 0.1 s per AudioData
  const ch = [buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)];
  for (let i = 0; i < buf.length; i += block) {
    const n = Math.min(block, buf.length - i);
    const planar = new Float32Array(n * 2);
    planar.set(ch[0].subarray(i, i + n), 0);
    planar.set(ch[1].subarray(i, i + n), n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: buf.sampleRate, numberOfFrames: n, numberOfChannels: 2,
                               timestamp: Math.round((i / buf.sampleRate) * 1e6), data: planar });
    enc.encode(ad);
    ad.close();
    if (err) throw err;
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
}

// ---- offline render ----
// Seek and wait until the frame at t is ready: the 'seeked' event, then briefly for a new-frame
// callback (it doesn't come when the seek lands on the same frame as before, e.g. when the
// output fps is higher than the video's, so only a short wait).
function offSeek(t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      if (video.requestVideoFrameCallback) { video.requestVideoFrameCallback(() => finish()); setTimeout(finish, 50); }
      else finish();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
    setTimeout(finish, 3000);
  });
}

async function offRender() {
  if (offRendering) { offCancel = true; return; }
  if (offRecording) offStopRecording();
  if (!offHasVideo()) { offStatus('load a video file first (Input: choose file)'); return; }
  if (!offPoints.length) { offStatus('record or load a timeline first'); return; }
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
    offStatus('needs a browser with WebCodecs (current Chrome or Edge)'); return;
  }
  offStatus('loading the MP4 writer...');
  let Mux;
  try { Mux = await import(OFF_MUXER_URL); } catch (e) { offStatus('cannot load the MP4 writer: ' + e.message); return; }

  const fps = Number($('offFps').value) || 30;
  const n = Math.max(1, Math.floor(video.duration * fps + 1e-6));
  let [w, h] = capSize(video.videoWidth, video.videoHeight);
  w = Math.max(2, w & ~1); h = Math.max(2, h & ~1);
  let config = null;
  for (const codec of OFF_CODECS) {
    const cfg = { codec, width: w, height: h, bitrate: OFF_BITRATE, framerate: fps };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) { config = cfg; break; } } catch { /* next */ }
  }
  if (!config) { offStatus(`no H.264 encoder available for ${w}x${h}`); return; }

  // Soundtrack first (fast, faster than real time), so the MP4 knows it has an audio track.
  let soundBuf = null, aCodec = null, soundNote = '';
  $('offRenderBtn').disabled = true;              // until the frame loop can be cancelled
  if ($('offSound').checked) {
    aCodec = await offAudioCodec();
    if (!aCodec) soundNote = ' (no soundtrack: this browser cannot encode audio)';
    else {
      offBusy = true;
      offStatus('rendering the soundtrack...');
      try { soundBuf = await offRenderSoundtrack(video.duration); }
      catch (e) { soundNote = ' (no soundtrack: ' + (e && e.message ? e.message : e) + ')'; }
      offBusy = false;
    }
  }

  const target = new Mux.ArrayBufferTarget();
  const muxer = new Mux.Muxer({ target, video: { codec: 'avc', width: w, height: h, frameRate: fps },
                                audio: soundBuf ? { codec: aCodec.mux, numberOfChannels: 2, sampleRate: OFF_AUDIO_RATE } : undefined,
                                fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  if (soundBuf) {
    try { await offEncodeAudio(soundBuf, aCodec, muxer); }
    catch (e) { offStatus('audio encoding failed: ' + (e && e.message ? e.message : e)); $('offRenderBtn').disabled = false; return; }
  }
  $('offRenderBtn').disabled = false;
  let encError = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encError = e; } });
  enc.configure(config);

  // Pause the live page and start from a clean state (feedback buffers, u_dt).
  offRendering = true; offCancel = false; offBusy = true;
  const wasPaused = video.paused, wasLoop = video.loop, savedEffInt = effInt;
  video.pause(); video.loop = false;
  $('offRenderBtn').textContent = 'Cancel';
  canvas.width = w; canvas.height = h;
  setTargetSize(w, h);
  for (const e of chain) resetFeedback(e);
  lastChainTime = null;
  const started = performance.now();
  try {
    for (let i = 0; i < n && !offCancel; i++) {
      const t = i / fps;
      await offSeek(Math.min(t, video.duration - 1e-3));
      uploadedFrame[0] = -1;                 // always upload the seeked frame
      effInt = offCurveAt(t);
      const out = renderChain(t);
      if (!out) throw new Error(`no video frame at ${t.toFixed(2)} s`);
      draw(copyProg, null, out, null, 0);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(t * 1e6), duration: Math.round(1e6 / fps) });
      enc.encode(frame, { keyFrame: i % Math.round(fps * 2) === 0 });
      frame.close();
      if (encError) throw encError;
      while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 2));
      if (i % 5 === 0 || i === n - 1) {
        const rate = (i + 1) / ((performance.now() - started) / 1000);
        offStatus(`rendering frame ${i + 1} / ${n}  (${rate.toFixed(1)} frames/s, about ${Math.ceil((n - i - 1) / rate)} s left)`);
      }
    }
    if (offCancel) {
      offStatus('render cancelled');
    } else {
      await enc.flush();
      if (encError) throw encError;
      muxer.finalize();
      const blob = new Blob([target.buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `vr-visuals-render-${offVideoName()}.mp4`;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      offStatus(`saved ${a.download} (${n} frames, ${(blob.size / 1e6).toFixed(1)} MB, ${((performance.now() - started) / 1000).toFixed(0)} s${soundBuf ? ', with soundtrack' : ''})${soundNote}`);
      window.offLastRender = { url, size: blob.size, frames: n, width: w, height: h };   // for checks
    }
  } catch (e) {
    offStatus('render failed: ' + (e && e.message ? e.message : e));
  } finally {
    if (enc.state !== 'closed') enc.close();
    offRendering = false; offBusy = false;
    effInt = savedEffInt;
    lastChainTime = null;
    for (const e of chain) resetFeedback(e);
    video.loop = wasLoop;
    if (!wasPaused) video.play().catch(() => {});
    $('offRenderBtn').textContent = 'Render video';
  }
}

$('offRecBtn').onclick = offToggleRecording;
$('offRenderBtn').onclick = offRender;
$('offSaveBtn').onclick = offSaveTimeline;
$('offWavBtn').onclick = offSoundtrackOnly;
$('offLoadBtn').onclick = () => $('offLoadIn').click();
$('offLoadIn').onchange = (ev) => { const f = ev.target.files[0]; if (f) offLoadTimeline(f); ev.target.value = ''; };
video.addEventListener('timeupdate', () => { if (!offRecording) offDrawCurve(); });
offDrawCurve();
