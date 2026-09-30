import { calibrationTests } from './calibrationTests';

export function TestIllustration({ step: currentStep, evidence = false }: { step: number; evidence?: boolean }) {
  const step = currentStep;
  return (
    <div className={`cal-art ${evidence ? 'cal-art-evidence' : ''}`}>
      <svg viewBox="0 0 420 230" role="img" aria-label={`${calibrationTests[step].model} illustration, not a real print photo`}>
        <defs><pattern id={`bed-${step}-${evidence}`} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" fill="none" stroke="currentColor" strokeWidth="0.6" /></pattern></defs>
        <path d="M45 170L210 89L375 170L210 222Z" fill={`url(#bed-${step}-${evidence})`} opacity="0.22" />
        {step === 0 ? <g fill="var(--accent)" stroke="var(--bg-primary)" strokeWidth="2">{[0, 1, 2, 3, 4].map(i => <g key={i} transform={`translate(150 ${169 - i * 29})`}><path d="M0 0L60 -24L121 0V14L60 39L0 14Z" opacity={0.65 + i * 0.07} /><path d="M18 -2L60 -19L103 -2V7L60 25L18 7Z" fill="var(--bg-secondary)" /><text x="62" y="28" textAnchor="middle" stroke="none" fill="var(--text-primary)" fontSize="10">{220 - i * 5}°</text></g>)}</g>
        : step === 1 ? <g>{[0, 1, 2, 3, 4].map(i => <g key={i} transform={`translate(${50 + i * 65} ${133 + (i % 2) * 20})`}><path d="M0 0L30 -15L59 0V12L30 28L0 12Z" fill="var(--accent)" opacity={0.5 + i * 0.1} />{[0, 1, 2, 3, 4].map(line => <path key={line} d={`M${6 + line * 6} ${-line * 3}l24 12`} stroke="var(--bg-primary)" opacity="0.35" />)}<text x="30" y="48" textAnchor="middle" fill="currentColor" fontSize="11">{calibrationTests[1].options[i]}</text></g>)}</g>
        : step === 2 ? <g fill="none" stroke="var(--accent)" strokeWidth="4">{[0, 1, 2, 3, 4].map(i => <path key={i} d={`M${80 + i * 8} ${155 - i * 23}l70 -32 70 32 70 -32 40 18`} opacity={0.5 + i * 0.1} />)}</g>
        : step === 3 ? <g fill="var(--accent)"><path d="M122 65l35 -16 22 13v115l-35 17 -22 -14Z" /><path d="M243 65l35 -16 22 13v115l-35 17 -22 -14Z" />{[0, 1, 2, 3].map(i => <path key={i} d={`M176 ${95 + i * 20}Q210 ${119 + i * 16} 245 ${95 + i * 20}`} stroke="var(--accent)" fill="none" opacity={0.15 + i * 0.15} />)}</g>
        : <g fill="none" stroke="var(--accent)" strokeWidth="4">{Array.from({ length: 12 }, (_, i) => <path key={i} d={`M100 ${177 - i * 9}Q100 ${150 - i * 9} 210 ${150 - i * 9}T320 ${177 - i * 9}`} opacity={0.35 + i * 0.05} />)}</g>}
      </svg>
      <span className="cal-art-caption">{evidence ? 'Illustrative evidence' : 'Test model preview'}</span>
    </div>
  );
}

