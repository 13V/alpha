"use client";

import { useEffect, useRef } from "react";

interface Props {
  onClose: () => void;
}

export default function HowItWorks({ onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // stop the page behind from scrolling while the sheet is open
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="hiw-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 id="hiw-title">how it works</h2>
          <button ref={closeRef} className="sheet-x" onClick={onClose} aria-label="Close">
            esc ✕
          </button>
        </header>

        <div className="sheet-body">
          <section>
            <h3>what you get</h3>
            <p>
              Paste a token&rsquo;s contract address and it returns the 100 wallets that made
              the most money on it, ranked by realized profit — with the market cap each one
              entered and exited at. Tick the ones you like and copy them straight into Axiom.
            </p>
            <p>
              It runs on <b>your own Dune API key</b>, which stays in your browser and is only
              passed through to Dune for that one query. Nothing is stored server-side.
            </p>
          </section>

          <section>
            <h3>how profit is worked out</h3>
            <pre>
{`acquired = tokens bought on a DEX
         + tokens received by transfer
cost     = USD spent + value of those transfers
           when they landed
pnl      = USD received
         − avg cost × min(sold, acquired)`}
            </pre>
            <p>
              That second line is the part most tools miss. On pump.fun tokens the biggest
              winners often never appear as buyers at all — on one token we measured, the
              top wallet had <b>1,290 sell fills and zero buy fills</b>. It had not bought;
              it received 21.9M tokens in a single transfer and sold them.
            </p>
            <p>
              Treating those as free would report every dollar of proceeds as profit. Ignoring
              them scores that wallet at exactly zero and hides it. So transfers in are valued
              at the market price at the moment they landed, and that becomes cost basis.
            </p>
          </section>

          <section>
            <h3>multiple vs ROI</h3>
            <p>
              <b>Multiple</b> is average sell price ÷ average buy price — the price gain per
              token round-tripped. <b>ROI</b> is profit against the capital actually put in.
              They match when a wallet opened and closed its whole position; a wallet that
              bought a lot and sold a little shows a big multiple and a small ROI, which is
              correct — most of its money is still on the table.
            </p>
          </section>

          <section>
            <h3>buys seen</h3>
            <p>
              How much of what a wallet sold we can account for, as a share. <b>100%</b> means
              the profit figure rests on a real cost basis. A low number means Dune has no
              record of where the rest came from, so that row&rsquo;s profit is an{" "}
              <b>upper bound</b> — treat it as a ceiling, not a measurement.
            </p>
          </section>

          <section>
            <h3>pick the right window</h3>
            <p>
              The window is the single easiest way to get a wrong answer. If it opens after
              the token launched, every launch-period buy is invisible and the real winners
              vanish from the list entirely — we saw a 398x wallet disappear completely at 90d
              and rank first at 1y on the same token.
            </p>
            <p>
              It defaults to a year and warns when a result&rsquo;s earliest trade sits at the
              window edge. Widen it when you see that. It costs about the same either way.
            </p>
          </section>

          <section>
            <h3>tracking them after</h3>
            <p>
              A list is only worth something if you can follow it. Every export takes the
              rows you have on screen, or just the ones you tick.
            </p>
            <ul>
              <li>
                <b>Axiom</b> — <i>Copy for Axiom</i> emits its tracked-wallet JSON, ready to
                paste into the import box. Groups, emoji and alert toggles come along with it.
              </li>
              <li>
                <b>Terminal</b> and <b>Photon</b> — <i>Terminal / Photon</i> copies one
                address per line, which is what both wallet trackers take pasted in. Any
                other tracker that accepts a plain list works off the same copy.
              </li>
              <li>
                <b>CSV</b> — every column, for your own spreadsheet.
              </li>
            </ul>
            <p>
              Wallet names are built from the run, so they stay meaningful in whatever you
              paste them into. <b>name by</b> switches between{" "}
              <code>14.10x - KIMCHI</code>, <code>$82.4K - KIMCHI</code>,{" "}
              <code>#3 - KIMCHI</code> and the shortened address.
            </p>
          </section>

          <section>
            <h3>what it cannot see</h3>
            <ul>
              <li>
                Dune&rsquo;s Solana pipeline runs <b>a few hours behind the chain</b>, so a
                token that launched today returns nothing until it catches up.
              </li>
              <li>
                Exchange and custodial wallets are excluded from the ranking — one moved 458M
                tokens across ~4,000 counterparties on a single token, which is a deposit
                sweep, not a trader.
              </li>
              <li>
                Prices come from Dune&rsquo;s own feed. On very thin pairs some fills carry no
                USD value at all, which drags a wallet&rsquo;s coverage down.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
