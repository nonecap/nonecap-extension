// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChallengeController, type ChallengeController } from './challenge-state';

const SINGLE_HTML = '<div class="challenge-container"><div class="prompt-text">Drag the ball</div></div>';

function gridHtml(): string {
  let html = '<div class="challenge-container">';
  for (let i = 1; i <= 4; i++) {
    html += `<div class="task-image"><div class="image" style="background: url('https://t/${i}.jpg')"></div></div>`;
  }
  return html + '</div>';
}

function makeController(): {
  controller: ChallengeController;
  sends: string[];
  prompts: string[];
} {
  const sends: string[] = [];
  const prompts: string[] = [];
  const controller = createChallengeController({
    doc: document,
    sendReady: (task, prompt) => {
      sends.push(task);
      prompts.push(prompt);
    },
  });
  return { controller, sends, prompts };
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
});

describe('prompt forwarding', () => {
  it('passes the DOM prompt text alongside the task on announce', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends, prompts } = makeController();

    controller.tick();

    expect(sends).toEqual(['single']);
    expect(prompts).toEqual(['Drag the ball']);
  });
});

describe('post-action re-arm probe', () => {
  it('re-arms after an action when a SINGLE challenge stays ready (atomic round swap, no not-ready window)', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['single']); // initial round announced

    // The background acts on the round (signalled via GET_GEOMETRY/CURSOR);
    // the round swaps atomically — the DOM is never observed not-ready,
    // which used to leave the edge disarmed forever.
    controller.noteAction();

    // Poll ticks inside the floor window: nothing fires (verifying overlay
    // guard) and the edge stays disarmed.
    vi.advanceTimersByTime(1000);
    controller.tick();
    expect(sends).toHaveLength(1);

    // Floor (2500ms) passes → probe sees the challenge still present + ready
    // → forces re-arm and announces the next round.
    vi.advanceTimersByTime(1600);
    expect(sends).toEqual(['single', 'single']);
  });

  it('is cancelled by teardown (CHALLENGE_GONE)', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['single']);

    controller.noteAction(); // probe armed

    // Challenge closes → teardown (the CHALLENGE_GONE path)…
    document.body.innerHTML = '';
    controller.teardown();
    // …and even though a ready-looking challenge reappears before the floor,
    // the cancelled probe must NOT fire on its own.
    document.body.innerHTML = SINGLE_HTML;
    vi.advanceTimersByTime(10_000);
    expect(sends).toHaveLength(1);
  });

  it('does not stack: a new action restarts the probe instead of doubling it', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    controller.noteAction();
    vi.advanceTimersByTime(1000); // first probe mid-flight…
    controller.noteAction(); // …superseded by the next action signal

    // Old probe's floor (would be at t=2500) passes — nothing fires early.
    vi.advanceTimersByTime(2000);
    expect(sends).toHaveLength(1);
    // Only the restarted probe fires, at its own floor.
    vi.advanceTimersByTime(600);
    expect(sends).toHaveLength(2);
  });

  it('stays additive: the normal not-ready→ready edge still announces grids, with no probe duplicate', () => {
    document.body.innerHTML = gridHtml();
    const { controller, sends } = makeController();

    controller.tick();
    expect(sends).toEqual(['grid']);

    controller.noteAction();

    // Grid rounds swap through a placeholder window: tiles lose their
    // background → observed not-ready → edge re-arms (normal path).
    const images = document.querySelectorAll('.task-image .image');
    for (const image of images) image.removeAttribute('style');
    controller.onMutation();
    controller.tick();
    expect(sends).toHaveLength(1);

    // New round loads before the probe floor.
    for (const [i, image] of [...images].entries()) {
      image.setAttribute('style', `background: url('https://t/next-${i}.jpg')`);
    }
    controller.onMutation();
    vi.advanceTimersByTime(400); // grid stability debounce (300ms)
    controller.tick();
    expect(sends).toEqual(['grid', 'grid']);

    // The probe must not re-announce the already-announced round at its floor.
    vi.advanceTimersByTime(5000);
    controller.tick();
    expect(sends).toHaveLength(2);
  });

  it('keeps probing on post-floor mutations when the floor check caught the verifying overlay', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    controller.noteAction();

    // At the floor the overlay still hides the prompt → not ready → probe
    // stays active instead of giving up.
    const prompt = document.querySelector('.prompt-text')!;
    prompt.textContent = '';
    vi.advanceTimersByTime(2600);
    expect(sends).toHaveLength(1);

    // Next round renders after the floor → mutation → probe re-arms; the
    // stability debounce still applies before the announce.
    prompt.textContent = 'Drag the new ball';
    controller.onMutation();
    expect(sends).toHaveLength(1); // mid-swap frame not captured
    vi.advanceTimersByTime(600); // single stability debounce (500ms)
    controller.tick();
    expect(sends).toEqual(['single', 'single']);
  });

  it('heartbeats keep the probe floor pushed out — no re-announce mid-action', () => {
    document.body.innerHTML = SINGLE_HTML;
    const { controller, sends } = makeController();
    controller.tick();
    expect(sends).toHaveLength(1);

    // A long background action: every GET_GEOMETRY answer / CURSOR op renews
    // the probe (noteAction heartbeat). While signals keep arriving within
    // the floor, the probe never fires and the edge stays disarmed.
    for (let i = 0; i < 10; i++) {
      controller.noteAction();
      vi.advanceTimersByTime(1000);
      controller.tick();
    }
    expect(sends).toHaveLength(1);

    // Action over (no more heartbeats): the probe fires at the floor counted
    // from the LAST signal.
    vi.advanceTimersByTime(1600); // 1000 + 1600 > 2500 floor
    expect(sends).toHaveLength(2);
  });
});
