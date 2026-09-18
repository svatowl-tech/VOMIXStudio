/**
 * Audio Engine matching C++ DAW Core DSP logic for live browser playback.
 * Implements Biquad EQ, Soft Knee Compressor, Auto-Ducking, and Master Soft Limiter.
 */

export interface ClipConfig {
  id: number;
  name: string;
  offsetSamples: number;
  lengthSamples: number;
  gain: number;
  pan: number;
  fadeInSamples: number;
  fadeOutSamples: number;
  buffer: Float32Array; // Mono or stereo sample buffer
  color: string;
}

export interface BiquadParams {
  type: 'lowshelf' | 'peaking' | 'highshelf';
  frequency: number;
  gainDb: number;
  Q: number;
  enabled: boolean;
}

export interface CompressorParams {
  thresholdDb: number;
  ratio: number;
  attackMs: number;
  releaseMs: number;
  makeupGainDb: number;
  kneeDb: number;
  enabled: boolean;
  currentGainReductionDb: number;
}

export interface AutoDuckerParams {
  thresholdDb: number;
  duckDepthDb: number;
  attackMs: number;
  releaseMs: number;
  enabled: boolean;
  sourceTrackId: number;
  currentDuckingGainDb: number;
}

export interface TrackState {
  id: number;
  name: string;
  volumeDb: number;
  pan: number;
  solo: boolean;
  mute: boolean;
  color: string;
  clips: ClipConfig[];
  eq: {
    lowShelf: BiquadParams;
    peaking: BiquadParams;
    highShelf: BiquadParams;
    enabled: boolean;
  };
  compressor: CompressorParams;
  autoDucker: AutoDuckerParams;
  peakL: number;
  peakR: number;
}

export interface MasterState {
  volumeDb: number;
  pan: number;
  limiterCeilingDb: number;
  limiterEnabled: boolean;
  peakL: number;
  peakR: number;
  clipped: boolean;
}

// Biquad State per channel
interface BiquadState {
  x1L: number; x2L: number; y1L: number; y2L: number;
  x1R: number; x2R: number; y1R: number; y2R: number;
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

function calcBiquadCoeffs(filter: BiquadParams, sampleRate: number): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const A = Math.pow(10, filter.gainDb / 40);
  const omega = (2 * Math.PI * filter.frequency) / sampleRate;
  const sn = Math.sin(omega);
  const cs = Math.cos(omega);
  const alpha = sn / (2 * Math.max(filter.Q, 0.001));
  const beta = Math.sqrt(A) / Math.max(filter.Q, 0.001);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (filter.type === 'lowshelf') {
    b0 = A * ((A + 1) - (A - 1) * cs + beta * sn);
    b1 = 2 * A * ((A - 1) - (A + 1) * cs);
    b2 = A * ((A + 1) - (A - 1) * cs - beta * sn);
    a0 = (A + 1) + (A - 1) * cs + beta * sn;
    a1 = -2 * ((A - 1) + (A + 1) * cs);
    a2 = (A + 1) + (A - 1) * cs - beta * sn;
  } else if (filter.type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cs;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cs;
    a2 = 1 - alpha / A;
  } else if (filter.type === 'highshelf') {
    b0 = A * ((A + 1) + (A - 1) * cs + beta * sn);
    b1 = -2 * A * ((A - 1) + (A + 1) * cs);
    b2 = A * ((A + 1) + (A - 1) * cs - beta * sn);
    a0 = (A + 1) - (A - 1) * cs + beta * sn;
    a1 = 2 * ((A - 1) - (A + 1) * cs);
    a2 = (A + 1) - (A - 1) * cs - beta * sn;
  }

  const invA0 = 1 / a0;
  return {
    b0: b0 * invA0,
    b1: b1 * invA0,
    b2: b2 * invA0,
    a1: a1 * invA0,
    a2: a2 * invA0
  };
}

export class LiveDAWEngine {
  private ctx: AudioContext | null = null;
  private scriptNode: ScriptProcessorNode | null = null;
  private isPlaying: boolean = false;
  private timelineSample: number = 0;
  private sampleRate: number = 48000;
  private tracks: TrackState[] = [];
  private master: MasterState = {
    volumeDb: 0,
    pan: 0,
    limiterCeilingDb: -0.1,
    limiterEnabled: true,
    peakL: 0,
    peakR: 0,
    clipped: false
  };

  // DSP State maps
  private eqStates: Map<string, BiquadState> = new Map();
  private compEnvelopes: Map<number, number> = new Map();
  private duckEnvelopes: Map<number, number> = new Map();

  private onStateUpdate?: (tracks: TrackState[], master: MasterState, positionSec: number) => void;

  constructor() {
    this.createDemoTracks();
  }

  public setUpdateCallback(cb: (tracks: TrackState[], master: MasterState, positionSec: number) => void) {
    this.onStateUpdate = cb;
  }

  private createDemoTracks() {
    const sr = 48000;
    const totalSec = 16;
    const totalSamples = sr * totalSec;

    // Track 1: Drums / Beat
    const drumBuffer = this.generateDrumBuffer(sr, totalSamples);
    // Track 2: Bass Synth
    const bassBuffer = this.generateBassBuffer(sr, totalSamples);
    // Track 3: Voice / Speech (for Auto-Ducking)
    const voiceBuffer = this.generateVoiceBuffer(sr, totalSamples);
    // Track 4: Chord Pad
    const padBuffer = this.generatePadBuffer(sr, totalSamples);

    this.tracks = [
      {
        id: 1,
        name: 'Drums (Rhythm)',
        volumeDb: -1.0,
        pan: 0,
        solo: false,
        mute: false,
        color: '#f43f5e',
        clips: [
          {
            id: 101,
            name: 'Drum Loop 120BPM',
            offsetSamples: 0,
            lengthSamples: totalSamples,
            gain: 1.0,
            pan: 0,
            fadeInSamples: 0,
            fadeOutSamples: 4800,
            buffer: drumBuffer,
            color: '#f43f5e'
          }
        ],
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 2.5, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 2500, gainDb: 1.5, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 8000, gainDb: 1.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -14,
          ratio: 4.0,
          attackMs: 15,
          releaseMs: 120,
          makeupGainDb: 1.5,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -20,
          duckDepthDb: -12,
          attackMs: 20,
          releaseMs: 300,
          enabled: false,
          sourceTrackId: 3,
          currentDuckingGainDb: 0
        },
        peakL: 0,
        peakR: 0
      },
      {
        id: 2,
        name: 'Synthesizer Bass',
        volumeDb: -2.0,
        pan: -0.15,
        solo: false,
        mute: false,
        color: '#3b82f6',
        clips: [
          {
            id: 102,
            name: 'Sub Synth Bass',
            offsetSamples: 0,
            lengthSamples: totalSamples,
            gain: 1.0,
            pan: 0,
            fadeInSamples: 0,
            fadeOutSamples: 4800,
            buffer: bassBuffer,
            color: '#3b82f6'
          }
        ],
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 90, gainDb: 3.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 800, gainDb: -2.0, Q: 1.2, enabled: true },
          highShelf: { type: 'highshelf', frequency: 6000, gainDb: -4.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -18,
          ratio: 6.0,
          attackMs: 8,
          releaseMs: 150,
          makeupGainDb: 2.0,
          kneeDb: 8,
          enabled: true,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -22,
          duckDepthDb: -10,
          attackMs: 15,
          releaseMs: 250,
          enabled: true, // Auto-duck bass under vocal speech!
          sourceTrackId: 3,
          currentDuckingGainDb: 0
        },
        peakL: 0,
        peakR: 0
      },
      {
        id: 3,
        name: 'Vocal / Speech Track',
        volumeDb: 1.5,
        pan: 0,
        solo: false,
        mute: false,
        color: '#10b981',
        clips: [
          {
            id: 103,
            name: 'Speech Voiceovers (Burst)',
            offsetSamples: 0,
            lengthSamples: totalSamples,
            gain: 1.2,
            pan: 0,
            fadeInSamples: 0,
            fadeOutSamples: 4800,
            buffer: voiceBuffer,
            color: '#10b981'
          }
        ],
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 150, gainDb: -3.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 3200, gainDb: 3.5, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -16,
          ratio: 3.5,
          attackMs: 10,
          releaseMs: 100,
          makeupGainDb: 1.0,
          kneeDb: 6,
          enabled: true,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -25,
          duckDepthDb: -12,
          attackMs: 20,
          releaseMs: 300,
          enabled: false,
          sourceTrackId: 0,
          currentDuckingGainDb: 0
        },
        peakL: 0,
        peakR: 0
      },
      {
        id: 4,
        name: 'Ambient Music Pad',
        volumeDb: -3.0,
        pan: 0.2,
        solo: false,
        mute: false,
        color: '#8b5cf6',
        clips: [
          {
            id: 104,
            name: 'Synth Chords Pad',
            offsetSamples: 0,
            lengthSamples: totalSamples,
            gain: 0.9,
            pan: 0,
            fadeInSamples: 9600,
            fadeOutSamples: 9600,
            buffer: padBuffer,
            color: '#8b5cf6'
          }
        ],
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 200, gainDb: -2.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 1500, gainDb: 1.0, Q: 0.8, enabled: true },
          highShelf: { type: 'highshelf', frequency: 7000, gainDb: 1.5, Q: 0.7071, enabled: true },
          enabled: true
        },
        compressor: {
          thresholdDb: -20,
          ratio: 2.5,
          attackMs: 25,
          releaseMs: 200,
          makeupGainDb: 0,
          kneeDb: 10,
          enabled: true,
          currentGainReductionDb: 0
        },
        autoDucker: {
          thresholdDb: -20,
          duckDepthDb: -14,
          attackMs: 25,
          releaseMs: 350,
          enabled: true, // Auto-duck music pad when voice is talking!
          sourceTrackId: 3,
          currentDuckingGainDb: 0
        },
        peakL: 0,
        peakR: 0
      }
    ];
  }

  // --- Audio Synthesis Generators for Demo Stems ---
  private generateDrumBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    const bpm = 120;
    const beatSamples = (60 / bpm) * sr;

    for (let i = 0; i < samples; i++) {
      const beatIdx = Math.floor(i / beatSamples);
      const posInBeat = i % beatSamples;
      const t = posInBeat / sr;

      // Kick on beats 0, 2, 4, 6...
      let sample = 0;
      if (beatIdx % 2 === 0) {
        const env = Math.exp(-t * 22);
        const freq = 130 * Math.exp(-t * 35) + 40;
        sample += Math.sin(2 * Math.PI * freq * t) * env * 0.8;
      }
      // Snare on beats 1, 3, 5, 7...
      if (beatIdx % 2 === 1) {
        const env = Math.exp(-t * 18);
        const noise = (Math.random() * 2 - 1) * env * 0.5;
        const tone = Math.sin(2 * Math.PI * 180 * t) * env * 0.3;
        sample += (noise + tone);
      }
      // Hi-hat on 8th notes
      const posInSubBeat = i % (beatSamples / 2);
      const tSub = posInSubBeat / sr;
      const hatEnv = Math.exp(-tSub * 60);
      sample += (Math.random() * 2 - 1) * hatEnv * 0.15;

      buf[i] = sample;
    }
    return buf;
  }

  private generateBassBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    const freqs = [55, 55, 65.41, 49]; // A1, A1, C2, G1
    const noteSamples = sr * 2;

    for (let i = 0; i < samples; i++) {
      const noteIdx = Math.floor(i / noteSamples) % freqs.length;
      const freq = freqs[noteIdx];
      const t = (i % noteSamples) / sr;
      const env = Math.exp(-t * 1.5);

      // Sawtooth + Sub Sine
      const saw = 2 * ((t * freq) - Math.floor(t * freq + 0.5));
      const sub = Math.sin(2 * Math.PI * (freq / 2) * t);
      buf[i] = (saw * 0.5 + sub * 0.5) * env * 0.5;
    }
    return buf;
  }

  private generateVoiceBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    // Periodic speech bursts every 3 seconds for 1.5s
    for (let i = 0; i < samples; i++) {
      const sec = i / sr;
      const cycleSec = sec % 4.0;
      if (cycleSec > 0.5 && cycleSec < 2.5) {
        const t = cycleSec - 0.5;
        const speechEnv = Math.sin((t / 2.0) * Math.PI) * (0.8 + 0.2 * Math.sin(20 * t));
        // Formant synthesis approximation
        const f0 = 150 + Math.sin(t * 8) * 30;
        const f1 = 600;
        const f2 = 1800;
        const v = Math.sin(2 * Math.PI * f0 * t) * 0.4
                + Math.sin(2 * Math.PI * f1 * t) * 0.3
                + Math.sin(2 * Math.PI * f2 * t) * 0.2;
        buf[i] = v * speechEnv * 0.6;
      } else {
        buf[i] = 0;
      }
    }
    return buf;
  }

  private generatePadBuffer(sr: number, samples: number): Float32Array {
    const buf = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const t = i / sr;
      // Soft rich chord (Am7: 220Hz, 261.63Hz, 329.63Hz, 392Hz)
      const c1 = Math.sin(2 * Math.PI * 220 * t);
      const c2 = Math.sin(2 * Math.PI * 261.63 * t);
      const c3 = Math.sin(2 * Math.PI * 329.63 * t);
      const c4 = Math.sin(2 * Math.PI * 392.00 * t);
      const lfo = 0.7 + 0.3 * Math.sin(2 * Math.PI * 0.2 * t);
      buf[i] = ((c1 + c2 + c3 + c4) * 0.15) * lfo;
    }
    return buf;
  }

  // --- Controls & Playback ---
  public async togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      await this.start();
    }
  }

  public async start() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      this.sampleRate = this.ctx.sampleRate;
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }

    const bufferSize = 512;
    this.scriptNode = this.ctx.createScriptProcessor(bufferSize, 0, 2);
    this.scriptNode.onaudioprocess = (e) => this.processAudio(e);
    this.scriptNode.connect(this.ctx.destination);
    this.isPlaying = true;
  }

  public pause() {
    if (this.scriptNode) {
      this.scriptNode.disconnect();
      this.scriptNode = null;
    }
    this.isPlaying = false;
  }

  public seek(positionSec: number) {
    this.timelineSample = Math.floor(positionSec * this.sampleRate);
  }

  public getTracks(): TrackState[] {
    return this.tracks;
  }

  public getMaster(): MasterState {
    return this.master;
  }

  public isEnginePlaying(): boolean {
    return this.isPlaying;
  }

  // --- Real-time DSP Processing Loop (Matching C++ DAW Core algorithms) ---
  private processAudio(e: AudioProcessingEvent) {
    const outL = e.outputBuffer.getChannelData(0);
    const outR = e.outputBuffer.getChannelData(1);
    const numFrames = e.outputBuffer.length;

    outL.fill(0);
    outR.fill(0);

    const hasSolo = this.tracks.some(t => t.solo && !t.mute);

    // Track sidechain buffers map
    const trackSidechains: Map<number, Float32Array> = new Map();
    for (const track of this.tracks) {
      const scMono = new Float32Array(numFrames);
      for (const clip of track.clips) {
        if (!clip.buffer) continue;
        for (let i = 0; i < numFrames; i++) {
          const samplePos = this.timelineSample + i;
          if (samplePos >= clip.offsetSamples && samplePos < clip.offsetSamples + clip.lengthSamples) {
            const idxInClip = samplePos - clip.offsetSamples;
            if (idxInClip < clip.buffer.length) {
              scMono[i] += clip.buffer[idxInClip] * clip.gain;
            }
          }
        }
      }
      trackSidechains.set(track.id, scMono);
    }

    let masterPeakL = 0;
    let masterPeakR = 0;

    for (const track of this.tracks) {
      if ((hasSolo && !track.solo) || track.mute) {
        track.peakL = 0;
        track.peakR = 0;
        continue;
      }

      const tempStereo = new Float32Array(numFrames * 2);

      // 1. Clips summation
      for (const clip of track.clips) {
        if (!clip.buffer) continue;
        for (let i = 0; i < numFrames; i++) {
          const samplePos = this.timelineSample + i;
          if (samplePos >= clip.offsetSamples && samplePos < clip.offsetSamples + clip.lengthSamples) {
            const idxInClip = samplePos - clip.offsetSamples;
            if (idxInClip < clip.buffer.length) {
              const sample = clip.buffer[idxInClip];

              let fadeGain = 1.0;
              if (clip.fadeInSamples > 0 && idxInClip < clip.fadeInSamples) {
                fadeGain = idxInClip / clip.fadeInSamples;
              }
              if (clip.fadeOutSamples > 0 && idxInClip >= clip.lengthSamples - clip.fadeOutSamples) {
                fadeGain = (clip.lengthSamples - idxInClip) / clip.fadeOutSamples;
              }

              const finalGain = clip.gain * fadeGain;
              const panL = Math.cos((clip.pan + 1) * 0.25 * Math.PI);
              const panR = Math.sin((clip.pan + 1) * 0.25 * Math.PI);

              tempStereo[i * 2] += sample * finalGain * panL;
              tempStereo[i * 2 + 1] += sample * finalGain * panR;
            }
          }
        }
      }

      // 2. Track Gain & Pan
      const trGain = Math.pow(10, track.volumeDb * 0.05);
      const trPanL = Math.cos((track.pan + 1) * 0.25 * Math.PI) * trGain;
      const trPanR = Math.sin((track.pan + 1) * 0.25 * Math.PI) * trGain;

      for (let i = 0; i < numFrames; i++) {
        tempStereo[i * 2] *= trPanL;
        tempStereo[i * 2 + 1] *= trPanR;
      }

      // 3. Biquad 3-Band EQ
      if (track.eq.enabled) {
        this.processEqForTrack(track, tempStereo, numFrames);
      }

      // 4. Soft Knee Compressor
      if (track.compressor.enabled) {
        this.processCompressorForTrack(track, tempStereo, numFrames);
      }

      // 5. Auto-Ducking
      if (track.autoDucker.enabled) {
        const scSourceBuffer = trackSidechains.get(track.autoDucker.sourceTrackId);
        this.processAutoDuckerForTrack(track, tempStereo, scSourceBuffer || new Float32Array(numFrames), numFrames);
      }

      // Sum into master & update track peak meters
      let trPeakL = 0;
      let trPeakR = 0;

      for (let i = 0; i < numFrames; i++) {
        const l = tempStereo[i * 2];
        const r = tempStereo[i * 2 + 1];
        outL[i] += l;
        outR[i] += r;

        trPeakL = Math.max(trPeakL, Math.abs(l));
        trPeakR = Math.max(trPeakR, Math.abs(r));
      }

      track.peakL = trPeakL;
      track.peakR = trPeakR;
    }

    // Master Volume & Pan
    const mGain = Math.pow(10, this.master.volumeDb * 0.05);
    const mPanL = Math.cos((this.master.pan + 1) * 0.25 * Math.PI) * mGain;
    const mPanR = Math.sin((this.master.pan + 1) * 0.25 * Math.PI) * mGain;

    for (let i = 0; i < numFrames; i++) {
      outL[i] *= mPanL;
      outR[i] *= mPanR;
    }

    // Master Soft Limiter
    let isClipped = false;
    const ceilingLinear = Math.pow(10, this.master.limiterCeilingDb * 0.05);

    for (let i = 0; i < numFrames; i++) {
      let l = outL[i];
      let r = outR[i];

      if (Math.abs(l) > 1.0 || Math.abs(r) > 1.0) {
        isClipped = true;
      }

      if (this.master.limiterEnabled) {
        if (Math.abs(l) > ceilingLinear * 0.7) {
          l = ceilingLinear * Math.tanh(l / ceilingLinear);
        }
        if (Math.abs(r) > ceilingLinear * 0.7) {
          r = ceilingLinear * Math.tanh(r / ceilingLinear);
        }
      }

      outL[i] = l;
      outR[i] = r;

      masterPeakL = Math.max(masterPeakL, Math.abs(l));
      masterPeakR = Math.max(masterPeakR, Math.abs(r));
    }

    this.master.peakL = masterPeakL;
    this.master.peakR = masterPeakR;
    this.master.clipped = isClipped;

    this.timelineSample += numFrames;

    // Loop timeline at 16 seconds
    if (this.timelineSample >= 16 * this.sampleRate) {
      this.timelineSample = 0;
    }

    if (this.onStateUpdate) {
      this.onStateUpdate(this.tracks, this.master, this.timelineSample / this.sampleRate);
    }
  }

  private processEqForTrack(track: TrackState, buffer: Float32Array, numFrames: number) {
    const filters = [track.eq.lowShelf, track.eq.peaking, track.eq.highShelf];

    for (let fIdx = 0; fIdx < filters.length; fIdx++) {
      const filter = filters[fIdx];
      if (!filter.enabled) continue;

      const key = `${track.id}_${fIdx}`;
      let bState = this.eqStates.get(key);
      if (!bState) {
        bState = { x1L: 0, x2L: 0, y1L: 0, y2L: 0, x1R: 0, x2R: 0, y1R: 0, y2R: 0, b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
        this.eqStates.set(key, bState);
      }

      const coeffs = calcBiquadCoeffs(filter, this.sampleRate);
      bState.b0 = coeffs.b0; bState.b1 = coeffs.b1; bState.b2 = coeffs.b2;
      bState.a1 = coeffs.a1; bState.a2 = coeffs.a2;

      for (let i = 0; i < numFrames; i++) {
        let inL = buffer[i * 2];
        let outL = bState.b0 * inL + bState.b1 * bState.x1L + bState.b2 * bState.x2L - bState.a1 * bState.y1L - bState.a2 * bState.y2L;
        bState.x2L = bState.x1L; bState.x1L = inL;
        bState.y2L = bState.y1L; bState.y1L = outL;
        buffer[i * 2] = outL;

        let inR = buffer[i * 2 + 1];
        let outR = bState.b0 * inR + bState.b1 * bState.x1R + bState.b2 * bState.x2R - bState.a1 * bState.y1R - bState.a2 * bState.y2R;
        bState.x2R = bState.x1R; bState.x1R = inR;
        bState.y2R = bState.y1R; bState.y1R = outR;
      }
    }
  }

  private processCompressorForTrack(track: TrackState, buffer: Float32Array, numFrames: number) {
    const comp = track.compressor;
    let env = this.compEnvelopes.get(track.id) || 0;

    const attackCoeff = Math.exp(-1 / (comp.attackMs * 0.001 * this.sampleRate));
    const releaseCoeff = Math.exp(-1 / (comp.releaseMs * 0.001 * this.sampleRate));
    const makeupGain = Math.pow(10, comp.makeupGainDb * 0.05);

    let maxGrDb = 0;

    for (let i = 0; i < numFrames; i++) {
      const left = buffer[i * 2];
      const right = buffer[i * 2 + 1];
      const peak = Math.max(Math.abs(left), Math.abs(right));

      if (peak > env) {
        env = attackCoeff * env + (1 - attackCoeff) * peak;
      } else {
        env = releaseCoeff * env + (1 - releaseCoeff) * peak;
      }

      const envDb = env <= 0.00001 ? -96 : 20 * Math.log10(env);
      let grDb = 0;
      const deltaDb = envDb - comp.thresholdDb;
      const halfKnee = comp.kneeDb * 0.5;

      if (deltaDb > halfKnee) {
        grDb = (comp.thresholdDb + deltaDb / comp.ratio) - envDb;
      } else if (deltaDb >= -halfKnee) {
        const diff = deltaDb + halfKnee;
        const kneeOut = deltaDb + ((1 / comp.ratio) - 1) * (diff * diff) / (2 * comp.kneeDb);
        grDb = kneeOut - deltaDb;
      }

      const grLinear = Math.pow(10, grDb * 0.05);
      const totalGain = grLinear * makeupGain;

      buffer[i * 2] *= totalGain;
      buffer[i * 2 + 1] *= totalGain;

      maxGrDb = Math.min(maxGrDb, grDb);
    }

    this.compEnvelopes.set(track.id, env);
    comp.currentGainReductionDb = maxGrDb;
  }

  private processAutoDuckerForTrack(track: TrackState, buffer: Float32Array, scMono: Float32Array, numFrames: number) {
    const ducker = track.autoDucker;
    let env = this.duckEnvelopes.get(track.id) || 0;

    const attackCoeff = Math.exp(-1 / (ducker.attackMs * 0.001 * this.sampleRate));
    const releaseCoeff = Math.exp(-1 / (ducker.releaseMs * 0.001 * this.sampleRate));
    const maxDuckGain = Math.pow(10, ducker.duckDepthDb * 0.05);

    let minDuckDb = 0;

    for (let i = 0; i < numFrames; i++) {
      const scPeak = Math.abs(scMono[i]);
      if (scPeak > env) {
        env = attackCoeff * env + (1 - attackCoeff) * scPeak;
      } else {
        env = releaseCoeff * env + (1 - releaseCoeff) * scPeak;
      }

      const scDb = env <= 0.00001 ? -96 : 20 * Math.log10(env);
      let duckGain = 1.0;

      if (scDb > ducker.thresholdDb) {
        const excessDb = scDb - ducker.thresholdDb;
        const amount = Math.min(1.0, Math.max(0.0, excessDb / 12.0));
        duckGain = 1.0 - amount * (1.0 - maxDuckGain);
      }

      buffer[i * 2] *= duckGain;
      buffer[i * 2 + 1] *= duckGain;

      const duckDb = 20 * Math.log10(Math.max(0.0001, duckGain));
      minDuckDb = Math.min(minDuckDb, duckDb);
    }

    this.duckEnvelopes.set(track.id, env);
    ducker.currentDuckingGainDb = minDuckDb;
  }
}
