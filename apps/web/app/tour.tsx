'use client';
import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui/icons';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/**
 * A short screen recording of the dashboard in demo mode, behind its own still. It plays when asked, or when it scrolls into view for someone
 * who allows motion; it is muted, loops, and is never fetched until then. The still is what everyone else sees.
 */
export function Tour({ poster, video, caption }: { poster: string; video: string; caption: string }) {
  const [playing, setPlaying] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) { setPlaying(true); io.disconnect(); } }, { threshold: 0.6 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => { if (playing) ref.current?.play().catch(() => setPlaying(false)); }, [playing]);
  return (
    <figure className="tour" ref={box} style={{ margin: 0 }}>
      <div className="frame">
        <div className="frame-bar" aria-hidden="true"><i /><i /><i /><span>agentontrack · dashboard · demo data</span></div>
        <span className="frame-note">Demo data</span>
        {playing
          ? <video ref={ref} src={`${BASE}${video}`} poster={`${BASE}${poster}`} muted loop playsInline controls preload="auto" aria-label={caption} data-testid="tour-video" />
          : <img src={`${BASE}${poster}`} alt="The AgentOnTrack dashboard showing demo projects, with invented data" width={1440} height={900} loading="eager" decoding="async" data-testid="tour-poster" />}
        {!playing ? <button type="button" className="tour-play" onClick={() => setPlaying(true)} data-testid="tour-play"><span className="icon" aria-hidden="true"><Icon name="play" size={18} /></span>Play the 20-second tour</button> : null}
      </div>
      <figcaption className="tour-cap"><span>{caption}</span><span>Recorded from the real dashboard in demo mode. Invented data, and the page says so.</span></figcaption>
    </figure>
  );
}
