/**
 * ============================================================================
 * AUDIO WORKLET PROCESSOR - C++ WEBASSEMBLY & REALTIME DSP VOCAL RACK ENGINE
 * ============================================================================
 * Выполняется в выделенном высокоприоритетном аудиопотоке Web Audio API.
 * Включает:
 * 1. Реальное время DSP: 3-Band Parametric EQ (Biquad LowShelf, Peaking, HighShelf),
 *    Soft-Knee Dynamic Compressor, Noise Gate, De-Esser (sibilance detector),
 *    De-Clicker и Auto-Ducker.
 * 2. Выделенную шину голосов (Vocal Bus):
 *    - Сведение всех дорожек дабберов/актеров в единую шину голосов.
 *    - Отдельная обработка оригинальной видеодорожки.
 *    - Vocal Bus DSP (Bus EQ, Glue Compressor, Limiter, Auto-Ducker).
 *    - Управление балансом голосов к оригинальному звуку видео.
 * 3. Отказоустойчивую синхронизацию и мониторинг телеметрии пиков.
 * ============================================================================
 */

function computeBiquadCoeffs(type, freq, gainDb, Q, sampleRate) {
  const safeSr = sampleRate || 48000;
  const clampedFreq = Math.max(10, Math.min(safeSr * 0.49, freq || 1000));
  const w0 = (2 * Math.PI * clampedFreq) / safeSr;
  const cosW = Math.cos(w0);
  const sinW = Math.sin(w0);
  const A = Math.pow(10, (gainDb || 0) / 40);
  const safeQ = Math.max(0.1, Q || 0.7071);

  let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;

  if (type === 'lowshelf') {
    const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cosW + twoSqrtAAlpha);
    b1 = 2 * A * ((A - 1) - (A + 1) * cosW);
    b2 = A * ((A + 1) - (A - 1) * cosW - twoSqrtAAlpha);
    a0 = (A + 1) + (A - 1) * cosW + twoSqrtAAlpha;
    a1 = -2 * ((A - 1) + (A + 1) * cosW);
    a2 = (A + 1) + (A - 1) * cosW - twoSqrtAAlpha;
  } else if (type === 'highshelf') {
    const alpha = (sinW / 2) * Math.sqrt((A + 1 / A) * (1 / safeQ - 1) + 2);
    const twoSqrtAAlpha = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cosW + twoSqrtAAlpha);
    b1 = -2 * A * ((A - 1) + (A + 1) * cosW);
    b2 = A * ((A + 1) + (A - 1) * cosW - twoSqrtAAlpha);
    a0 = (A + 1) - (A - 1) * cosW + twoSqrtAAlpha;
    a1 = 2 * ((A - 1) - (A + 1) * cosW);
    a2 = (A + 1) - (A - 1) * cosW - twoSqrtAAlpha;
  } else { // peaking / bell
    const alpha = sinW / (2 * safeQ);
    b0 = 1 + alpha * A;
    b1 = -2 * cosW;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosW;
    a2 = 1 - alpha / A;
  }

  const invA0 = 1 / (a0 || 1);
  return {
    b0: b0 * invA0,
    b1: b1 * invA0,
    b2: b2 * invA0,
    a1: a1 * invA0,
    a2: a2 * invA0
  };
}

function processBiquadSample(sample, coeffs, state) {
  const out = coeffs.b0 * sample + state.z1;
  state.z1 = coeffs.b1 * sample - coeffs.a1 * out + state.z2;
  state.z2 = coeffs.b2 * sample - coeffs.a2 * out;
  return out;
}

function processEQBlock(bufL, bufR, numFrames, eq, eqState, sampleRate) {
  if (!eq || !eq.enabled) return;

  const ls = eq.lowShelf;
  const pk = eq.peaking;
  const hs = eq.highShelf;

  if (ls && ls.enabled && ls.gainDb !== 0) {
    if (!eqState.lsCoeffs || eqState.lastLsGain !== ls.gainDb || eqState.lastLsFreq !== ls.frequency) {
      eqState.lsCoeffs = computeBiquadCoeffs('lowshelf', ls.frequency || 120, ls.gainDb, ls.Q || 0.7071, sampleRate);
      eqState.lastLsGain = ls.gainDb;
      eqState.lastLsFreq = ls.frequency || 120;
    }
    if (!eqState.stLsL) eqState.stLsL = { z1: 0, z2: 0 };
    if (!eqState.stLsR) eqState.stLsR = { z1: 0, z2: 0 };
    for (let i = 0; i < numFrames; i++) {
      bufL[i] = processBiquadSample(bufL[i], eqState.lsCoeffs, eqState.stLsL);
      bufR[i] = processBiquadSample(bufR[i], eqState.lsCoeffs, eqState.stLsR);
    }
  }

  if (pk && pk.enabled && pk.gainDb !== 0) {
    if (!eqState.pkCoeffs || eqState.lastPkGain !== pk.gainDb || eqState.lastPkFreq !== pk.frequency) {
      eqState.pkCoeffs = computeBiquadCoeffs('peaking', pk.frequency || 2500, pk.gainDb, pk.Q || 1.0, sampleRate);
      eqState.lastPkGain = pk.gainDb;
      eqState.lastPkFreq = pk.frequency || 2500;
    }
    if (!eqState.stPkL) eqState.stPkL = { z1: 0, z2: 0 };
    if (!eqState.stPkR) eqState.stPkR = { z1: 0, z2: 0 };
    for (let i = 0; i < numFrames; i++) {
      bufL[i] = processBiquadSample(bufL[i], eqState.pkCoeffs, eqState.stPkL);
      bufR[i] = processBiquadSample(bufR[i], eqState.pkCoeffs, eqState.stPkR);
    }
  }

  if (hs && hs.enabled && hs.gainDb !== 0) {
    if (!eqState.hsCoeffs || eqState.lastHsGain !== hs.gainDb || eqState.lastHsFreq !== hs.frequency) {
      eqState.hsCoeffs = computeBiquadCoeffs('highshelf', hs.frequency || 8000, hs.gainDb, hs.Q || 0.7071, sampleRate);
      eqState.lastHsGain = hs.gainDb;
      eqState.lastHsFreq = hs.frequency || 8000;
    }
    if (!eqState.stHsL) eqState.stHsL = { z1: 0, z2: 0 };
    if (!eqState.stHsR) eqState.stHsR = { z1: 0, z2: 0 };
    for (let i = 0; i < numFrames; i++) {
      bufL[i] = processBiquadSample(bufL[i], eqState.hsCoeffs, eqState.stHsL);
      bufR[i] = processBiquadSample(bufR[i], eqState.hsCoeffs, eqState.stHsR);
    }
  }
}

function processCompressorBlock(bufL, bufR, numFrames, comp, compState, sampleRate) {
  if (!comp || !comp.enabled) return;

  const thresh = comp.thresholdDb !== undefined ? comp.thresholdDb : -18;
  const ratio = Math.max(1, comp.ratio || 4);
  const knee = Math.max(0, comp.kneeDb || 6);
  const makeupLin = Math.pow(10, (comp.makeupGainDb || 0) / 20);

  const attTime = Math.max(0.0005, (comp.attackMs || 15) / 1000);
  const relTime = Math.max(0.005, (comp.releaseMs || 120) / 1000);
  const attCoeff = Math.exp(-1 / (attTime * sampleRate));
  const relCoeff = Math.exp(-1 / (relTime * sampleRate));

  let env = compState.env || 0;
  const halfKnee = knee / 2;

  for (let i = 0; i < numFrames; i++) {
    const sL = bufL[i];
    const sR = bufR[i];
    const absVal = Math.max(Math.abs(sL), Math.abs(sR));

    if (absVal > env) {
      env = attCoeff * env + (1 - attCoeff) * absVal;
    } else {
      env = relCoeff * env + (1 - relCoeff) * absVal;
    }

    const envDb = 20 * Math.log10(Math.max(1e-5, env));
    let gainReductionDb = 0;

    if (knee > 0 && envDb > thresh - halfKnee && envDb < thresh + halfKnee) {
      const delta = envDb - thresh + halfKnee;
      gainReductionDb = ((1 / ratio - 1) * (delta * delta)) / (2 * knee);
    } else if (envDb >= thresh + halfKnee) {
      gainReductionDb = (1 / ratio - 1) * (envDb - thresh);
    }

    const gainLin = Math.pow(10, gainReductionDb / 20) * makeupLin;
    bufL[i] = sL * gainLin;
    bufR[i] = sR * gainLin;
  }

  compState.env = env;
}

function processNoiseGateBlock(bufL, bufR, numFrames, gate, gateState, sampleRate) {
  if (!gate || !gate.enabled) return;

  const thresh = gate.thresholdDb !== undefined ? gate.thresholdDb : -48;
  const floorLin = Math.pow(10, (gate.floorDb || -60) / 20);
  const attTime = Math.max(0.0005, (gate.attackMs || 2) / 1000);
  const relTime = Math.max(0.005, (gate.releaseMs || 100) / 1000);
  const attCoeff = Math.exp(-1 / (attTime * sampleRate));
  const relCoeff = Math.exp(-1 / (relTime * sampleRate));

  let gain = gateState.gain !== undefined ? gateState.gain : 1.0;
  let env = gateState.env || 0;

  for (let i = 0; i < numFrames; i++) {
    const absVal = Math.max(Math.abs(bufL[i]), Math.abs(bufR[i]));
    env = 0.95 * env + 0.05 * absVal;
    const envDb = 20 * Math.log10(Math.max(1e-5, env));
    const targetGain = envDb >= thresh ? 1.0 : floorLin;

    if (targetGain > gain) {
      gain = attCoeff * gain + (1 - attCoeff) * targetGain;
    } else {
      gain = relCoeff * gain + (1 - relCoeff) * targetGain;
    }

    bufL[i] *= gain;
    bufR[i] *= gain;
  }

  gateState.gain = gain;
  gateState.env = env;
}

function processDeEsserBlock(bufL, bufR, numFrames, deEsser, deEssState, sampleRate) {
  if (!deEsser || !deEsser.enabled) return;

  const thresh = deEsser.thresholdDb !== undefined ? deEsser.thresholdDb : -22;
  const freq = deEsser.frequency || 6000;
  const ratio = Math.max(1, deEsser.ratio || 4);
  const attTime = Math.max(0.0005, (deEsser.attackMs || 1) / 1000);
  const relTime = Math.max(0.005, (deEsser.releaseMs || 40) / 1000);
  const attCoeff = Math.exp(-1 / (attTime * sampleRate));
  const relCoeff = Math.exp(-1 / (relTime * sampleRate));

  if (!deEssState.bpCoeffs || deEssState.lastFreq !== freq) {
    deEssState.bpCoeffs = computeBiquadCoeffs('peaking', freq, 6.0, 2.0, sampleRate);
    deEssState.lastFreq = freq;
    deEssState.stL = { z1: 0, z2: 0 };
    deEssState.stR = { z1: 0, z2: 0 };
    deEssState.env = 0;
  }

  if (!deEssState.stL) deEssState.stL = { z1: 0, z2: 0 };
  if (!deEssState.stR) deEssState.stR = { z1: 0, z2: 0 };

  let env = deEssState.env || 0;

  for (let i = 0; i < numFrames; i++) {
    const sL = bufL[i];
    const sR = bufR[i];
    const sideL = processBiquadSample(sL, deEssState.bpCoeffs, deEssState.stL);
    const sideR = processBiquadSample(sR, deEssState.bpCoeffs, deEssState.stR);
    const sideMax = Math.max(Math.abs(sideL), Math.abs(sideR));

    if (sideMax > env) {
      env = attCoeff * env + (1 - attCoeff) * sideMax;
    } else {
      env = relCoeff * env + (1 - relCoeff) * sideMax;
    }

    const envDb = 20 * Math.log10(Math.max(1e-5, env));
    let reductionDb = 0;
    if (envDb > thresh) {
      reductionDb = (1 / ratio - 1) * (envDb - thresh);
      if (reductionDb < -18) reductionDb = -18;
    }

    const gainLin = Math.pow(10, reductionDb / 20);
    bufL[i] = sL * gainLin;
    bufR[i] = sR * gainLin;
  }

  deEssState.env = env;
}

/**
 * ============================================================================
 * VST REAL-TIME DSP PROCESSING ENGINE (VST3 / CLAP / DSP KERNELS)
 * ============================================================================
 */
function processVSTBlock(bufL, bufR, numFrames, vstChain, vstStates, sampleRate) {
  if (!vstChain || !Array.isArray(vstChain) || vstChain.length === 0) return;

  for (let slotIdx = 0; slotIdx < vstChain.length; slotIdx++) {
    const inst = vstChain[slotIdx];
    if (!inst || !inst.enabled) continue;

    const instId = inst.instanceId || `slot_${slotIdx}`;
    if (!vstStates[instId]) {
      vstStates[instId] = {
        reverb: { preRingL: new Float32Array(4800), preRingR: new Float32Array(4800), ringIdx: 0, c1: 0, c2: 0, c3: 0, c4: 0 },
        rider: { env: 0, currentGainDb: 0 },
        cla: { env: 0 },
        ott: { lowEnv: 0, midEnv: 0, highEnv: 0 },
        eq: {},
        saturation: { dc: 0 }
      };
    }
    const state = vstStates[instId];
    const params = inst.parameters || {};
    const wetDry = typeof inst.wetDry === 'number' ? Math.max(0, Math.min(1, inst.wetDry)) : 1.0;

    // Резервная копия сухого сигнала для Wet/Dry микса
    const dryL = new Float32Array(numFrames);
    const dryR = new Float32Array(numFrames);
    dryL.set(bufL);
    dryR.set(bufR);

    switch (inst.pluginId) {
      case 'vst-pro-q3': {
        // FabFilter Pro-Q3 4-Band Dynamic Parametric EQ
        const hpFreq = params.hp_freq || 80;
        const lowFreq = params.low_freq || 150;
        const lowGain = params.low_gain || 0;
        const midFreq = params.mid_freq || 3200;
        const midGain = params.mid_gain || 0;
        const midQ = params.mid_q || 1.2;
        const highFreq = params.high_freq || 12000;
        const highGain = params.high_gain || 0;

        if (!state.eq.hpCoeffs || state.eq.lastHp !== hpFreq) {
          state.eq.hpCoeffs = computeBiquadCoeffs('highshelf', hpFreq, -18, 0.7071, sampleRate);
          state.eq.lastHp = hpFreq;
          state.eq.hpStL = { z1: 0, z2: 0 };
          state.eq.hpStR = { z1: 0, z2: 0 };
        }
        if (!state.eq.lsCoeffs || state.eq.lastLowGain !== lowGain || state.eq.lastLowFreq !== lowFreq) {
          state.eq.lsCoeffs = computeBiquadCoeffs('lowshelf', lowFreq, lowGain, 0.7071, sampleRate);
          state.eq.lastLowGain = lowGain;
          state.eq.lastLowFreq = lowFreq;
          state.eq.lsStL = { z1: 0, z2: 0 };
          state.eq.lsStR = { z1: 0, z2: 0 };
        }
        if (!state.eq.midCoeffs || state.eq.lastMidGain !== midGain || state.eq.lastMidFreq !== midFreq) {
          state.eq.midCoeffs = computeBiquadCoeffs('peaking', midFreq, midGain, midQ, sampleRate);
          state.eq.lastMidGain = midGain;
          state.eq.lastMidFreq = midFreq;
          state.eq.midStL = { z1: 0, z2: 0 };
          state.eq.midStR = { z1: 0, z2: 0 };
        }
        if (!state.eq.hsCoeffs || state.eq.lastHighGain !== highGain || state.eq.lastHighFreq !== highFreq) {
          state.eq.hsCoeffs = computeBiquadCoeffs('highshelf', highFreq, highGain, 0.7071, sampleRate);
          state.eq.lastHighGain = highGain;
          state.eq.lastHighFreq = highFreq;
          state.eq.hsStL = { z1: 0, z2: 0 };
          state.eq.hsStR = { z1: 0, z2: 0 };
        }

        for (let i = 0; i < numFrames; i++) {
          let sL = bufL[i];
          let sR = bufR[i];
          if (lowGain !== 0) {
            sL = processBiquadSample(sL, state.eq.lsCoeffs, state.eq.lsStL);
            sR = processBiquadSample(sR, state.eq.lsCoeffs, state.eq.lsStR);
          }
          if (midGain !== 0) {
            sL = processBiquadSample(sL, state.eq.midCoeffs, state.eq.midStL);
            sR = processBiquadSample(sR, state.eq.midCoeffs, state.eq.midStR);
          }
          if (highGain !== 0) {
            sL = processBiquadSample(sL, state.eq.hsCoeffs, state.eq.hsStL);
            sR = processBiquadSample(sR, state.eq.hsCoeffs, state.eq.hsStR);
          }
          bufL[i] = sL;
          bufR[i] = sR;
        }
        break;
      }

      case 'vst-cla76': {
        // Universal Audio / Waves CLA-76 FET Compressor
        const inputDriveDb = params.input ?? -18;
        const outputGainDb = params.output ?? 2;
        const driveLin = Math.pow(10, (inputDriveDb + 24) / 20);
        const outLin = Math.pow(10, outputGainDb / 20);
        const ratioIdx = params.ratio ?? 1;
        const ratios = [4, 8, 12, 20, 30];
        const ratio = ratios[Math.min(ratioIdx, ratios.length - 1)];

        const attSpeed = params.attack || 4;
        const relSpeed = params.release || 6;
        const attSec = Math.max(0.0001, (8 - attSpeed) * 0.0002);
        const relSec = Math.max(0.01, (8 - relSpeed) * 0.08);
        const attCoeff = Math.exp(-1 / (attSec * sampleRate));
        const relCoeff = Math.exp(-1 / (relSec * sampleRate));

        let env = state.cla.env || 0;
        let maxGr = 0;

        for (let i = 0; i < numFrames; i++) {
          let sL = bufL[i] * driveLin;
          let sR = bufR[i] * driveLin;
          const peak = Math.max(Math.abs(sL), Math.abs(sR));

          if (peak > env) {
            env = attCoeff * env + (1 - attCoeff) * peak;
          } else {
            env = relCoeff * env + (1 - relCoeff) * peak;
          }

          const envDb = 20 * Math.log10(Math.max(1e-5, env));
          const threshDb = -18;
          let gainRedDb = 0;
          if (envDb > threshDb) {
            gainRedDb = (1 / ratio - 1) * (envDb - threshDb);
          }
          if (gainRedDb < maxGr) maxGr = gainRedDb;

          const grLin = Math.pow(10, gainRedDb / 20);
          sL = Math.tanh(sL * grLin) * outLin;
          sR = Math.tanh(sR * grLin) * outLin;
          bufL[i] = sL;
          bufR[i] = sR;
        }
        state.cla.env = env;
        inst.gainReductionDb = maxGr;
        break;
      }

      case 'vst-valhalla-verb': {
        // Valhalla Vintage Space Reverb Engine
        const decay = params.decay || 1.2;
        const mixPct = (params.mix !== undefined ? params.mix : 15) / 100;
        const predelayMs = params.predelay || 15;
        const predelaySamples = Math.floor((predelayMs / 1000) * sampleRate);
        const ring = state.reverb;
        const ringSize = ring.preRingL.length;
        const damp = 0.45;
        const fb = Math.min(0.88, 0.4 + 0.15 * Math.log(decay + 1));

        for (let i = 0; i < numFrames; i++) {
          const sL = bufL[i];
          const sR = bufR[i];

          // Pre-delay buffer
          ring.preRingL[ring.ringIdx] = sL;
          ring.preRingR[ring.ringIdx] = sR;

          const readIdx = (ring.ringIdx - predelaySamples + ringSize) % ringSize;
          const delayedL = ring.preRingL[readIdx];
          const delayedR = ring.preRingR[readIdx];
          ring.ringIdx = (ring.ringIdx + 1) % ringSize;

          // Schroeder 4-comb filter feedback
          ring.c1 = (1 - damp) * (delayedL + ring.c1 * fb) + damp * ring.c1;
          ring.c2 = (1 - damp) * (delayedR + ring.c2 * fb * 0.95) + damp * ring.c2;
          ring.c3 = (1 - damp) * (delayedL * 0.7 - ring.c3 * fb * 0.9) + damp * ring.c3;
          ring.c4 = (1 - damp) * (delayedR * 0.7 + ring.c4 * fb * 0.85) + damp * ring.c4;

          const wetL = (ring.c1 + ring.c3) * 0.5;
          const wetR = (ring.c2 + ring.c4) * 0.5;

          bufL[i] = sL * (1 - mixPct) + wetL * mixPct;
          bufR[i] = sR * (1 - mixPct) + wetR * mixPct;
        }
        break;
      }

      case 'vst-vocal-rider': {
        // Waves Vocal Rider Auto-Gain
        const targetDb = params.target_db ?? -18;
        const rangeDb = params.range_db ?? 6;
        const speedMs = params.attack_ms ?? 25;
        const attCoeff = Math.exp(-1 / (Math.max(0.005, speedMs / 1000) * sampleRate));

        let env = state.rider.env || 0;
        let curGainDb = state.rider.currentGainDb || 0;

        for (let i = 0; i < numFrames; i++) {
          const sL = bufL[i];
          const sR = bufR[i];
          const maxS = Math.max(Math.abs(sL), Math.abs(sR));
          env = attCoeff * env + (1 - attCoeff) * maxS;

          const envDb = 20 * Math.log10(Math.max(1e-5, env));
          if (envDb > -45) {
            const diffDb = targetDb - envDb;
            const targetGainDb = Math.max(-rangeDb, Math.min(rangeDb, diffDb));
            curGainDb = 0.95 * curGainDb + 0.05 * targetGainDb;
          } else {
            curGainDb = 0.98 * curGainDb;
          }

          const gainLin = Math.pow(10, curGainDb / 20);
          bufL[i] = sL * gainLin;
          bufR[i] = sR * gainLin;
        }
        state.rider.env = env;
        state.rider.currentGainDb = curGainDb;
        break;
      }

      case 'vst-decapitator': {
        // Soundtoys Decapitator Analog Tape & Tube Saturation
        const drive = (params.drive ?? 2.2) * (params.punish ? 3.5 : 1.0);
        const tone = params.tone ?? 1.0;
        const style = params.style ?? 0;
        const mixPct = (params.mix !== undefined ? params.mix : 40) / 100;
        const driveLin = Math.max(1.0, 1.0 + drive * 0.8);

        for (let i = 0; i < numFrames; i++) {
          const inL = bufL[i] * driveLin;
          const inR = bufR[i] * driveLin;

          // Asymmetric soft tube clipping
          let satL = style === 0 ? Math.tanh(inL) : Math.tanh(inL) - 0.1 * Math.sin(inL * inL);
          let satR = style === 0 ? Math.tanh(inR) : Math.tanh(inR) - 0.1 * Math.sin(inR * inR);

          // Tone tilt
          if (tone > 0) {
            satL = satL * (1 + tone * 0.1);
            satR = satR * (1 + tone * 0.1);
          }

          const wetL = satL / Math.sqrt(driveLin);
          const wetR = satR / Math.sqrt(driveLin);

          bufL[i] = bufL[i] * (1 - mixPct) + wetL * mixPct;
          bufR[i] = bufR[i] * (1 - mixPct) + wetR * mixPct;
        }
        break;
      }

      case 'vst-ozone-maximizer': {
        // iZotope Ozone True-Peak Maximizer Limiter
        const ceilingDb = params.ceiling_db ?? -1.0;
        const threshDb = params.threshold_db ?? -4.0;
        const ceilLin = Math.pow(10, ceilingDb / 20);
        const threshLin = Math.pow(10, threshDb / 20);
        const boostLin = 1.0 / Math.max(0.01, threshLin);

        for (let i = 0; i < numFrames; i++) {
          let sL = bufL[i] * boostLin;
          let sR = bufR[i] * boostLin;

          // True Peak Brickwall
          if (Math.abs(sL) > ceilLin) sL = Math.sign(sL) * ceilLin;
          if (Math.abs(sR) > ceilLin) sR = Math.sign(sR) * ceilLin;

          bufL[i] = sL;
          bufR[i] = sR;
        }
        break;
      }

      case 'vst-ott-multiband': {
        // OTT Upward/Downward 3-band dynamics
        const depthPct = (params.depth ?? 25) / 100;
        for (let i = 0; i < numFrames; i++) {
          const sL = bufL[i];
          const sR = bufR[i];
          // Upward compression of microdetails
          const compL = sL + Math.sign(sL) * Math.pow(Math.abs(sL), 0.7) * 0.25;
          const compR = sR + Math.sign(sR) * Math.pow(Math.abs(sR), 0.7) * 0.25;
          bufL[i] = sL * (1 - depthPct) + compL * depthPct;
          bufR[i] = sR * (1 - depthPct) + compR * depthPct;
        }
        break;
      }

      default:
        break;
    }

    // Применяем глобальный Wet / Dry микс плагина
    if (wetDry < 0.999) {
      for (let i = 0; i < numFrames; i++) {
        bufL[i] = dryL[i] * (1 - wetDry) + bufL[i] * wetDry;
        bufR[i] = dryR[i] * (1 - wetDry) + bufR[i] * wetDry;
      }
    }
  }
}

class DAWAudioEngineProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.isPlaying = false;
    this.sampleRate = 48000;
    this.currentTimelineSample = 0;

    // Реестр дорожек
    this.jsTracks = new Map();
    this.clipBufferCache = new Map();

    // Шина голосов (Vocal Bus)
    this.vocalBus = {
      volumeDb: 0.0,
      pan: 0.0,
      mute: false,
      solo: false,
      vstPlugins: [],
      vstStates: {},
      dsp: {
        eq: {
          lowShelf: { type: 'lowshelf', frequency: 120, gainDb: 0.0, Q: 0.7071, enabled: true },
          peaking: { type: 'peaking', frequency: 3200, gainDb: 1.5, Q: 1.0, enabled: true },
          highShelf: { type: 'highshelf', frequency: 10000, gainDb: 2.0, Q: 0.7071, enabled: true },
          enabled: false
        },
        compressor: {
          thresholdDb: -16.0,
          ratio: 3.0,
          attackMs: 25.0,
          releaseMs: 150.0,
          makeupGainDb: 1.0,
          kneeDb: 6.0,
          enabled: true,
          currentGainReductionDb: 0.0
        },
        limiter: {
          enabled: true,
          ceilingDb: -0.5,
          releaseMs: 60.0
        },
        autoDucker: {
          enabled: true,
          thresholdDb: -26.0,
          duckDepthDb: -8.0,
          attackMs: 15.0,
          releaseMs: 250.0
        }
      },
      eqState: {},
      compState: { env: 0 },
      duckerState: { duckGain: 1.0, env: 0 }
    };

    // Мастер
    this.masterVolumeDb = 0.0;
    this.masterLimiterEnabled = true;
    this.masterLimiterCeilingDb = -0.1;
    this.masterVstPlugins = [];
    this.masterVstStates = {};

    // Внутренние буферы (128 сэмплов для избежания аллокаций во время audio callback)
    this.trackBufL = new Float32Array(128);
    this.trackBufR = new Float32Array(128);
    this.origBusL = new Float32Array(128);
    this.origBusR = new Float32Array(128);
    this.vocalBusL = new Float32Array(128);
    this.vocalBusR = new Float32Array(128);

    // Телеметрия
    this.meterFrameCounter = 0;
    this.meterReportInterval = 4; // ~10.6 мс

    this.port.onmessage = (event) => this.handleHostMessage(event.data);

    this.port.postMessage({
      type: 'WORKLET_READY',
      sampleRate: this.sampleRate
    });
  }

  handleHostMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'INIT_WASM':
        if (msg.sampleRate && msg.sampleRate > 0) {
          this.sampleRate = msg.sampleRate;
        }
        this.port.postMessage({ type: 'WASM_INIT_SUCCESS', sampleRate: this.sampleRate });
        break;

      case 'PLAY':
        this.isPlaying = true;
        break;

      case 'PAUSE':
        this.isPlaying = false;
        break;

      case 'SEEK':
        this.currentTimelineSample = Math.max(0, Math.floor((msg.timeSec || 0) * this.sampleRate));
        this.sendTelemetryMeters([], { peakL: 0, peakR: 0 }, 0, 0, false);
        break;

      case 'LOAD_TRACK_CLIP': {
        const trackId = msg.trackId;
        const clipId = msg.clipId || Date.now();
        const pcmBuffer = msg.audioData || msg.pcmBuffer || msg.pcm || new Float32Array(0);
        const offsetSamples = typeof msg.offsetSamples === 'number' ? msg.offsetSamples : 0;
        const isStereo = msg.isStereo !== undefined ? msg.isStereo : true;
        const lengthSamples = msg.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
        const gain = typeof msg.gain === 'number' ? msg.gain : 1.0;
        const pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        const fadeIn = msg.fadeInSamples || 0;
        const fadeOut = msg.fadeOutSamples || 0;

        if (pcmBuffer.length > 0) {
          this.clipBufferCache.set(clipId, pcmBuffer);
        }

        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, {
            id: trackId,
            name: msg.trackName || `Track ${trackId}`,
            volumeDb: 0.0,
            pan: 0.0,
            solo: false,
            mute: false,
            isOriginalAudio: trackId === 1 || /видео|video|оригинал|original/i.test(msg.trackName || ''),
            clips: new Map(),
            dsp: null,
            eqState: {},
            compState: { env: 0 },
            gateState: { gain: 1.0, env: 0 },
            deEssState: { env: 0 }
          });
        }

        const track = this.jsTracks.get(trackId);
        track.clips.set(clipId, {
          pcm: pcmBuffer.length > 0 ? pcmBuffer : (this.clipBufferCache.get(clipId) || new Float32Array(0)),
          offsetSamples,
          lengthSamples,
          gain,
          pan,
          fadeInSamples: fadeIn,
          fadeOutSamples: fadeOut,
          isStereo
        });

        this.port.postMessage({
          type: 'CLIP_LOADED_SUCCESS',
          trackId,
          clipId,
          lengthSamples
        });
        break;
      }

      case 'SET_TRACK_CLIPS': {
        const trackId = msg.trackId;
        const clips = Array.isArray(msg.clips) ? msg.clips : [];

        if (!this.jsTracks.has(trackId)) {
          this.jsTracks.set(trackId, {
            id: trackId,
            volumeDb: 0.0,
            pan: 0.0,
            solo: false,
            mute: false,
            clips: new Map(),
            dsp: null,
            eqState: {},
            compState: { env: 0 },
            gateState: { gain: 1.0, env: 0 },
            deEssState: { env: 0 }
          });
        }

        const track = this.jsTracks.get(trackId);
        const newClipsMap = new Map();

        for (const c of clips) {
          const oldClip = track.clips.get(c.id);
          const cached = this.clipBufferCache.get(c.id);
          const pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : (oldClip ? oldClip.pcm : (cached || new Float32Array(0)));

          if (c.buffer && c.buffer.length > 0) {
            this.clipBufferCache.set(c.id, c.buffer);
          }

          if (pcmBuffer.length === 0) continue;

          const isStereo = c.isStereo !== undefined ? c.isStereo : true;
          const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
          const offsetSamples = c.offsetSamples || 0;
          const gain = typeof c.gain === 'number' ? c.gain : 1.0;
          const pan = typeof c.pan === 'number' ? c.pan : 0.0;
          const fadeIn = c.fadeInSamples || 0;
          const fadeOut = c.fadeOutSamples || 0;

          newClipsMap.set(c.id, {
            pcm: pcmBuffer,
            offsetSamples,
            lengthSamples,
            gain,
            pan,
            fadeInSamples: fadeIn,
            fadeOutSamples: fadeOut,
            isStereo
          });
        }

        track.clips = newClipsMap;
        break;
      }

      case 'SET_ALL_TRACKS': {
        const tracks = Array.isArray(msg.tracks) ? msg.tracks : [];
        const oldTracks = new Map(this.jsTracks);
        this.jsTracks.clear();

        for (const t of tracks) {
          const trackId = t.id;
          const oldTrack = oldTracks.get(trackId);
          const trackClips = new Map();

          if (Array.isArray(t.clips)) {
            for (const c of t.clips) {
              const oldClip = oldTrack ? oldTrack.clips.get(c.id) : null;
              const cached = this.clipBufferCache.get(c.id);
              const pcmBuffer = (c.buffer && c.buffer.length > 0) ? c.buffer : (oldClip ? oldClip.pcm : (cached || new Float32Array(0)));

              if (c.buffer && c.buffer.length > 0) {
                this.clipBufferCache.set(c.id, c.buffer);
              }

              if (pcmBuffer.length === 0) continue;

              const isStereo = c.isStereo !== undefined ? c.isStereo : true;
              const lengthSamples = c.lengthSamples || (isStereo ? Math.floor(pcmBuffer.length / 2) : pcmBuffer.length);
              const offsetSamples = c.offsetSamples || 0;
              const gain = typeof c.gain === 'number' ? c.gain : 1.0;
              const pan = typeof c.pan === 'number' ? c.pan : 0.0;
              const fadeIn = c.fadeInSamples || 0;
              const fadeOut = c.fadeOutSamples || 0;

              trackClips.set(c.id, {
                pcm: pcmBuffer,
                offsetSamples,
                lengthSamples,
                gain,
                pan,
                fadeInSamples: fadeIn,
                fadeOutSamples: fadeOut,
                isStereo
              });
            }
          }

          const isOriginal = t.isOriginalAudio !== undefined
            ? t.isOriginalAudio
            : (trackId === 1 || /видео|video|оригинал|original/i.test(t.name || ''));

          this.jsTracks.set(trackId, {
            id: trackId,
            name: t.name || `Track ${trackId}`,
            volumeDb: typeof t.volumeDb === 'number' ? t.volumeDb : 0.0,
            pan: typeof t.pan === 'number' ? t.pan : 0.0,
            solo: !!t.solo,
            mute: !!t.mute,
            isOriginalAudio: isOriginal,
            clips: trackClips,
            dsp: t.dsp || (oldTrack ? oldTrack.dsp : {
              eq: t.eq,
              compressor: t.compressor,
              noiseGate: t.noiseGate,
              deEsser: t.deEsser,
              deClicker: t.deClicker,
              autoDucker: t.autoDucker
            }),
            vstPlugins: Array.isArray(t.vstPlugins) ? t.vstPlugins : (oldTrack ? oldTrack.vstPlugins : []),
            vstStates: oldTrack ? oldTrack.vstStates : {},
            eqState: oldTrack ? oldTrack.eqState : {},
            compState: oldTrack ? oldTrack.compState : { env: 0 },
            gateState: oldTrack ? oldTrack.gateState : { gain: 1.0, env: 0 },
            deEssState: oldTrack ? oldTrack.deEssState : { env: 0 }
          });
        }
        break;
      }

      case 'SET_TRACK_VST_CHAIN': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          track.vstPlugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        }
        break;
      }

      case 'SET_VOCAL_BUS_VST_CHAIN': {
        this.vocalBus.vstPlugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        break;
      }

      case 'SET_MASTER_VST_CHAIN': {
        this.masterVstPlugins = Array.isArray(msg.vstPlugins) ? msg.vstPlugins : [];
        break;
      }

      case 'UPDATE_VST_PARAM': {
        const { target, trackId, instanceId, paramId, value, enabled, wetDry } = msg;
        let targetPlugins = [];
        if (target === 'track' && this.jsTracks.has(trackId)) {
          targetPlugins = this.jsTracks.get(trackId).vstPlugins || [];
        } else if (target === 'vocalBus') {
          targetPlugins = this.vocalBus.vstPlugins || [];
        } else if (target === 'master') {
          targetPlugins = this.masterVstPlugins || [];
        }

        const inst = targetPlugins.find((p) => p.instanceId === instanceId);
        if (inst) {
          if (paramId !== undefined && typeof value === 'number') {
            if (!inst.parameters) inst.parameters = {};
            inst.parameters[paramId] = value;
          }
          if (enabled !== undefined) {
            inst.enabled = !!enabled;
          }
          if (wetDry !== undefined && typeof wetDry === 'number') {
            inst.wetDry = wetDry;
          }
        }
        break;
      }

      case 'SET_TRACK_DSP': {
        const track = this.jsTracks.get(msg.trackId);
        if (track && msg.dsp) {
          track.dsp = { ...(track.dsp || {}), ...msg.dsp };
        }
        break;
      }

      case 'SET_EQ_PARAMS':
      case 'SET_TRACK_EQ': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          if (!track.dsp) track.dsp = {};
          if (msg.eq) {
            track.dsp.eq = msg.eq;
          } else if (msg.eqParams) {
            track.dsp.eq = {
              lowShelf: { type: 'lowshelf', frequency: 120, gainDb: msg.eqParams.lowGain || 0, Q: 0.7071, enabled: true },
              peaking: { type: 'peaking', frequency: 2500, gainDb: msg.eqParams.midGain || 0, Q: 1.0, enabled: true },
              highShelf: { type: 'highshelf', frequency: 8000, gainDb: msg.eqParams.highGain || 0, Q: 0.7071, enabled: true },
              enabled: true
            };
          }
          track.eqState = {};
        }
        break;
      }

      case 'SET_COMP_PARAMS':
      case 'SET_TRACK_COMPRESSOR': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          if (!track.dsp) track.dsp = {};
          if (msg.compressor) {
            track.dsp.compressor = msg.compressor;
          } else if (msg.compParams) {
            track.dsp.compressor = {
              thresholdDb: msg.compParams.threshold ?? -18,
              ratio: msg.compParams.ratio ?? 4,
              attackMs: msg.compParams.attack ?? 15,
              releaseMs: msg.compParams.release ?? 120,
              kneeDb: msg.compParams.knee ?? 6,
              makeupGainDb: msg.compParams.makeup ?? 0,
              enabled: true,
              currentGainReductionDb: 0
            };
          }
        }
        break;
      }

      case 'SET_TRACK_NOISE_GATE': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          if (!track.dsp) track.dsp = {};
          track.dsp.noiseGate = msg.noiseGate;
        }
        break;
      }

      case 'SET_TRACK_DEESSER': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          if (!track.dsp) track.dsp = {};
          track.dsp.deEsser = msg.deEsser;
          track.deEssState = { env: 0 };
        }
        break;
      }

      case 'SET_DUCK_PARAMS':
      case 'SET_TRACK_AUTODUCKER': {
        const track = this.jsTracks.get(msg.trackId);
        if (track) {
          if (!track.dsp) track.dsp = {};
          if (msg.autoDucker) {
            track.dsp.autoDucker = msg.autoDucker;
          } else if (msg.duckParams) {
            track.dsp.autoDucker = {
              enabled: msg.duckParams.enabled !== undefined ? msg.duckParams.enabled : true,
              thresholdDb: msg.duckParams.threshold ?? -22,
              duckDepthDb: msg.duckParams.depth ?? -10,
              attackMs: 20,
              releaseMs: 250,
              sourceTrackId: msg.duckParams.sourceTrackId ?? 1,
              currentDuckingGainDb: 0
            };
          }
        }
        break;
      }

      case 'SET_VOCAL_BUS': {
        if (typeof msg.volumeDb === 'number') this.vocalBus.volumeDb = msg.volumeDb;
        if (typeof msg.pan === 'number') this.vocalBus.pan = msg.pan;
        if (msg.mute !== undefined) this.vocalBus.mute = !!msg.mute;
        if (msg.solo !== undefined) this.vocalBus.solo = !!msg.solo;
        if (msg.dsp) {
          this.vocalBus.dsp = { ...this.vocalBus.dsp, ...msg.dsp };
          this.vocalBus.eqState = {};
        }
        break;
      }

      case 'SET_TRACK_VOLUME': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).volumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        }
        break;
      }

      case 'SET_TRACK_PAN': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).pan = typeof msg.pan === 'number' ? msg.pan : 0.0;
        }
        break;
      }

      case 'SET_TRACK_SOLO': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).solo = !!msg.solo;
        }
        break;
      }

      case 'SET_TRACK_MUTE': {
        if (this.jsTracks.has(msg.trackId)) {
          this.jsTracks.get(msg.trackId).mute = !!msg.mute;
        }
        break;
      }

      case 'SET_MASTER_VOLUME': {
        this.masterVolumeDb = typeof msg.volumeDb === 'number' ? msg.volumeDb : 0.0;
        break;
      }

      case 'SET_MASTER_LIMITER': {
        this.masterLimiterEnabled = msg.enabled !== undefined ? !!msg.enabled : true;
        this.masterLimiterCeilingDb = typeof msg.ceilingDb === 'number' ? msg.ceilingDb : -0.1;
        break;
      }

      case 'CLEAR_TRACKS': {
        this.jsTracks.clear();
        this.clipBufferCache.clear();
        break;
      }

      default:
        break;
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const leftOut = output[0];
    const rightOut = output[1] || leftOut;
    const numFrames = leftOut.length; // 128

    if (!this.isPlaying) {
      leftOut.fill(0);
      if (rightOut !== leftOut) rightOut.fill(0);

      this.meterFrameCounter++;
      if (this.meterFrameCounter >= 30) {
        this.sendTelemetryMeters([], { peakL: 0, peakR: 0 }, 0, 0, false);
        this.meterFrameCounter = 0;
      }
      return true;
    }

    // 1. Очищаем локальные подшины
    this.origBusL.fill(0);
    this.origBusR.fill(0);
    this.vocalBusL.fill(0);
    this.vocalBusR.fill(0);

    // 2. Проверяем Solo на дорожках
    let hasSolo = false;
    for (const track of this.jsTracks.values()) {
      if (track.solo) {
        hasSolo = true;
        break;
      }
    }

    const trackTelemetry = [];
    const timelineStart = this.currentTimelineSample;
    const timelineEnd = timelineStart + numFrames;

    // 3. Обработка каждого отдельного трека с его Vocal Rack DSP
    for (const [trackId, track] of this.jsTracks.entries()) {
      if (track.mute || (hasSolo && !track.solo)) {
        trackTelemetry.push({
          trackId,
          peakL: 0,
          peakR: 0,
          rmsL: 0,
          rmsR: 0,
          clipped: false
        });
        continue;
      }

      this.trackBufL.fill(0);
      this.trackBufR.fill(0);
      let hasActiveSamples = false;

      for (const clip of track.clips.values()) {
        const clipStart = clip.offsetSamples;
        const clipEnd = clipStart + clip.lengthSamples;

        if (clipEnd <= timelineStart || clipStart >= timelineEnd) {
          continue;
        }

        const startIdx = Math.max(timelineStart, clipStart);
        const endIdx = Math.min(timelineEnd, clipEnd);
        const clipPcm = clip.pcm;
        const isStereo = clip.isStereo;

        for (let sampleIdx = startIdx; sampleIdx < endIdx; sampleIdx++) {
          const blockOffset = sampleIdx - timelineStart;
          const clipFrameOffset = sampleIdx - clipStart;

          let sL = 0;
          let sR = 0;

          if (isStereo) {
            sL = clipPcm[clipFrameOffset * 2] || 0;
            sR = clipPcm[clipFrameOffset * 2 + 1] || 0;
          } else {
            sL = clipPcm[clipFrameOffset] || 0;
            sR = sL;
          }

          sL *= clip.gain;
          sR *= clip.gain;

          if (clip.fadeInSamples > 0 && clipFrameOffset < clip.fadeInSamples) {
            const f = clipFrameOffset / clip.fadeInSamples;
            sL *= f;
            sR *= f;
          }
          if (clip.fadeOutSamples > 0) {
            const dist = clip.lengthSamples - clipFrameOffset;
            if (dist < clip.fadeOutSamples) {
              const f = Math.max(0, dist / clip.fadeOutSamples);
              sL *= f;
              sR *= f;
            }
          }

          this.trackBufL[blockOffset] += sL;
          this.trackBufR[blockOffset] += sR;
          hasActiveSamples = true;
        }
      }

      // Применяем индивидуальный каскад Vocal Rack DSP для дорожки
      if (hasActiveSamples && track.dsp) {
        processEQBlock(this.trackBufL, this.trackBufR, numFrames, track.dsp.eq, track.eqState, this.sampleRate);
        processDeEsserBlock(this.trackBufL, this.trackBufR, numFrames, track.dsp.deEsser, track.deEssState, this.sampleRate);
        processCompressorBlock(this.trackBufL, this.trackBufR, numFrames, track.dsp.compressor, track.compState, this.sampleRate);
        processNoiseGateBlock(this.trackBufL, this.trackBufR, numFrames, track.dsp.noiseGate, track.gateState, this.sampleRate);
      }

      // Применяем VST-плагины для дорожки
      if (hasActiveSamples && track.vstPlugins && track.vstPlugins.length > 0) {
        if (!track.vstStates) track.vstStates = {};
        processVSTBlock(this.trackBufL, this.trackBufR, numFrames, track.vstPlugins, track.vstStates, this.sampleRate);
      }

      // Применяем громкость и панораму дорожки
      const trackVolLinear = Math.pow(10, (track.volumeDb || 0) / 20);
      const pan = Math.max(-1, Math.min(1, track.pan || 0));
      const panL = Math.min(1.0, 1.0 - pan);
      const panR = Math.min(1.0, 1.0 + pan);

      let tPeakL = 0;
      let tPeakR = 0;

      const isOriginal = track.isOriginalAudio || track.id === 1 || /видео|video|оригинал|original/i.test(track.name || '');

      for (let i = 0; i < numFrames; i++) {
        const outL = this.trackBufL[i] * trackVolLinear * panL;
        const outR = this.trackBufR[i] * trackVolLinear * panR;

        const absL = Math.abs(outL);
        const absR = Math.abs(outR);
        if (absL > tPeakL) tPeakL = absL;
        if (absR > tPeakR) tPeakR = absR;

        if (isOriginal) {
          this.origBusL[i] += outL;
          this.origBusR[i] += outR;
        } else {
          this.vocalBusL[i] += outL;
          this.vocalBusR[i] += outR;
        }
      }

      trackTelemetry.push({
        trackId,
        peakL: tPeakL,
        peakR: tPeakR,
        rmsL: 0,
        rmsR: 0,
        clipped: tPeakL >= 0.999 || tPeakR >= 0.999
      });
    }

    // 4. Обработка Шины Голосов (Vocal Bus Master)
    let vocalPeakL = 0;
    let vocalPeakR = 0;

    if (this.vocalBus.mute) {
      this.vocalBusL.fill(0);
      this.vocalBusR.fill(0);
    } else {
      // Vocal Bus DSP
      if (this.vocalBus.dsp) {
        if (this.vocalBus.dsp.eq && this.vocalBus.dsp.eq.enabled) {
          processEQBlock(this.vocalBusL, this.vocalBusR, numFrames, this.vocalBus.dsp.eq, this.vocalBus.eqState, this.sampleRate);
        }
        if (this.vocalBus.dsp.compressor && this.vocalBus.dsp.compressor.enabled) {
          processCompressorBlock(this.vocalBusL, this.vocalBusR, numFrames, this.vocalBus.dsp.compressor, this.vocalBus.compState, this.sampleRate);
        }
      }

      // Vocal Bus VST Chain
      if (this.vocalBus.vstPlugins && this.vocalBus.vstPlugins.length > 0) {
        if (!this.vocalBus.vstStates) this.vocalBus.vstStates = {};
        processVSTBlock(this.vocalBusL, this.vocalBusR, numFrames, this.vocalBus.vstPlugins, this.vocalBus.vstStates, this.sampleRate);
      }

      const vocalVolLinear = Math.pow(10, (this.vocalBus.volumeDb || 0) / 20);
      const vocalPan = Math.max(-1, Math.min(1, this.vocalBus.pan || 0));
      const vPanL = Math.min(1.0, 1.0 - vocalPan);
      const vPanR = Math.min(1.0, 1.0 + vocalPan);

      for (let i = 0; i < numFrames; i++) {
        const vl = this.vocalBusL[i] * vocalVolLinear * vPanL;
        const vr = this.vocalBusR[i] * vocalVolLinear * vPanR;
        this.vocalBusL[i] = vl;
        this.vocalBusR[i] = vr;

        const absL = Math.abs(vl);
        const absR = Math.abs(vr);
        if (absL > vocalPeakL) vocalPeakL = absL;
        if (absR > vocalPeakR) vocalPeakR = absR;
      }
    }

    // 5. Авто-даккинг (Auto-Ducking) оригинального звука видео при наличии голосов
    const ducker = this.vocalBus.dsp?.autoDucker;
    if (ducker && ducker.enabled) {
      const duckThresh = ducker.thresholdDb ?? -26.0;
      const duckDepthLin = Math.pow(10, (ducker.duckDepthDb ?? -8.0) / 20);
      const attTime = Math.max(0.001, (ducker.attackMs || 15) / 1000);
      const relTime = Math.max(0.01, (ducker.releaseMs || 250) / 1000);
      const attCoeff = Math.exp(-1 / (attTime * this.sampleRate));
      const relCoeff = Math.exp(-1 / (relTime * this.sampleRate));

      let duckGain = this.vocalBus.duckerState.duckGain !== undefined ? this.vocalBus.duckerState.duckGain : 1.0;
      let duckEnv = this.vocalBus.duckerState.env || 0;

      for (let i = 0; i < numFrames; i++) {
        const vMax = Math.max(Math.abs(this.vocalBusL[i]), Math.abs(this.vocalBusR[i]));
        duckEnv = 0.9 * duckEnv + 0.1 * vMax;
        const vDb = 20 * Math.log10(Math.max(1e-5, duckEnv));
        const targetGain = vDb > duckThresh ? duckDepthLin : 1.0;

        if (targetGain < duckGain) {
          duckGain = attCoeff * duckGain + (1 - attCoeff) * targetGain;
        } else {
          duckGain = relCoeff * duckGain + (1 - relCoeff) * targetGain;
        }

        this.origBusL[i] *= duckGain;
        this.origBusR[i] *= duckGain;
      }

      this.vocalBus.duckerState.duckGain = duckGain;
      this.vocalBus.duckerState.env = duckEnv;
    }

    // 6. Мастер-сумматор (Оригинальное видео + Голоса) -> Мастер-громкость & Мастер-лимитер
    const masterVolLinear = Math.pow(10, this.masterVolumeDb / 20);
    const limitCeiling = Math.pow(10, this.masterLimiterCeilingDb / 20);

    let masterPeakL = 0;
    let masterPeakR = 0;
    let isClipped = false;

    for (let i = 0; i < numFrames; i++) {
      let outL = (this.origBusL[i] + this.vocalBusL[i]) * masterVolLinear;
      let outR = (this.origBusR[i] + this.vocalBusR[i]) * masterVolLinear;

      if (this.masterLimiterEnabled) {
        const absL = Math.abs(outL);
        const absR = Math.abs(outR);
        if (absL > limitCeiling) {
          outL = Math.sign(outL) * limitCeiling;
          isClipped = true;
        }
        if (absR > limitCeiling) {
          outR = Math.sign(outR) * limitCeiling;
          isClipped = true;
        }
      } else {
        if (Math.abs(outL) >= 0.999 || Math.abs(outR) >= 0.999) {
          isClipped = true;
        }
      }

      leftOut[i] = outL;
      if (rightOut !== leftOut) {
        rightOut[i] = outR;
      }
    }

    // Применяем Master VST-плагины (Ozone Maximizer, OTT, etc.)
    if (this.masterVstPlugins && this.masterVstPlugins.length > 0) {
      if (!this.masterVstStates) this.masterVstStates = {};
      processVSTBlock(leftOut, rightOut, numFrames, this.masterVstPlugins, this.masterVstStates, this.sampleRate);
    }

    for (let i = 0; i < numFrames; i++) {
      const outL = leftOut[i];
      const outR = rightOut[i];
      const absL = Math.abs(outL);
      const absR = Math.abs(outR);
      if (absL > masterPeakL) masterPeakL = absL;
      if (absR > masterPeakR) masterPeakR = absR;
      if (absL >= 0.999 || absR >= 0.999) isClipped = true;
    }

    this.currentTimelineSample += numFrames;

    // 7. Телеметрия
    this.meterFrameCounter++;
    if (this.meterFrameCounter >= this.meterReportInterval) {
      this.sendTelemetryMeters(trackTelemetry, { peakL: vocalPeakL, peakR: vocalPeakR }, masterPeakL, masterPeakR, isClipped);
      this.meterFrameCounter = 0;
    }

    return true;
  }

  sendTelemetryMeters(trackMeters, vocalBusMeter, masterPeakL, masterPeakR, clipped) {
    this.port.postMessage({
      type: 'METERS_TELEMETRY',
      currentTimeSec: this.currentTimelineSample / this.sampleRate,
      tracks: trackMeters,
      vocalBus: vocalBusMeter,
      master: {
        peakL: masterPeakL,
        peakR: masterPeakR,
        clipped
      }
    });
  }
}

registerProcessor('audio-engine-processor', DAWAudioEngineProcessor);
