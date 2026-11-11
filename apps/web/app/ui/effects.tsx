'use client';
import { useEffect } from 'react';

/** Framed things that react to the pointer: the light that follows it across a tile, and the magnifier over a screenshot. */
const SPOT = '[data-spot], .tile, .projects-entry, .gate, .shot .frame-media';

/**
 * Small page-level behaviours. The content never depends on them: without JavaScript every section is simply there, finished.
 *  - the header learns that the page has scrolled, so it can draw its hairline;
 *  - a framed thing under the pointer learns where the pointer is (two custom properties, read by the stylesheet);
 *  - browsers without scroll-linked CSS get the section reveal from an observer instead.
 * For someone who prefers reduced motion, just the scrolled flag is set, and it moves nothing.
 */
export function Effects() {
  useEffect(() => {
    const root = document.documentElement;
    let scrolled: boolean | null = null;
    const onScroll = () => {
      const now = window.scrollY > 4;
      if (now === scrolled) return;
      scrolled = now;
      if (now) root.dataset.scrolled = ''; else delete root.dataset.scrolled;
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return () => window.removeEventListener('scroll', onScroll);

    let frame = 0;
    let last: PointerEvent | null = null;
    const paint = () => {
      frame = 0;
      const target = last?.target;
      if (!last || !(target instanceof Element)) return;
      const host = target.closest<HTMLElement>(SPOT);
      if (!host) return;
      const box = host.querySelector<HTMLElement>(':scope > [data-spot-layer]') ?? host;
      const r = box.getBoundingClientRect();
      box.style.setProperty('--mx', `${Math.round(last.clientX - r.left)}px`);
      box.style.setProperty('--my', `${Math.round(last.clientY - r.top)}px`);
    };
    const onMove = (e: PointerEvent) => { if (e.pointerType === 'touch') return; last = e; if (!frame) frame = requestAnimationFrame(paint); };
    window.addEventListener('pointermove', onMove, { passive: true });

    // Where the stylesheet's scroll-linked reveal is not understood, do the same thing once per element as it comes into view.
    // What starts below the fold is held back and nothing else, so nothing already on screen ever blinks.
    let io: IntersectionObserver | null = null;
    const scrollLinked = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('animation-timeline: view()');
    if (!scrollLinked && typeof IntersectionObserver !== 'undefined') {
      const seen = new WeakSet<Element>();
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const el = entry.target;
          if (entry.isIntersecting) {
            if (el.classList.contains('pre')) { el.classList.remove('pre'); el.classList.add('in'); }
            io?.unobserve(el);
          } else if (!seen.has(el)) el.classList.add('pre');
          seen.add(el);
        }
      }, { rootMargin: '0px 0px -8% 0px' });
      for (const el of document.querySelectorAll('.reveal')) io.observe(el);
    }
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('pointermove', onMove); cancelAnimationFrame(frame); io?.disconnect(); };
  }, []);
  return null;
}
