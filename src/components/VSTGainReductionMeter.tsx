import React from 'react';

interface VSTGainReductionMeterProps {
  grDb: number; // 0 to -30 dB typically
  active?: boolean;
}

export const VSTGainReductionMeter: React.FC<VSTGainReductionMeterProps> = ({
  grDb,
  active = true
}) => {
  // Normalize GR (0 dB = 0%, -24 dB = 100%)
  const clampedDb = Math.min(0, Math.max(-24, grDb));
  const pct = active ? Math.abs(clampedDb) / 24 * 100 : 0;

  return (
    <div
      className="flex items-center gap-1 bg-slate-950/80 px-1.5 py-0.5 rounded border border-slate-800"
      title={`Gain Reduction: ${clampedDb.toFixed(1)} dB`}
    >
      <span className="text-[8px] font-mono font-bold text-amber-400/90 shrink-0">GR</span>
      <div className="w-10 h-1.5 bg-slate-900 rounded-sm overflow-hidden flex flex-row-reverse relative">
        <div
          className="h-full transition-all duration-75 rounded-sm"
          style={{
            width: `${pct}%`,
            backgroundColor: pct > 50 ? '#ef4444' : pct > 25 ? '#f59e0b' : '#10b981'
          }}
        />
      </div>
      <span className="text-[8px] font-mono text-slate-400 min-w-[20px] text-right">
        {active && clampedDb < -0.1 ? `${clampedDb.toFixed(0)}dB` : '0dB'}
      </span>
    </div>
  );
};
