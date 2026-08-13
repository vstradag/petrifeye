// OCULUS RUN — a side-scrolling platformer played with your eyes.
//
//   look UP    -> jump
//   look DOWN  -> duck
//   blink      -> shoot     (Neon only; Space always works as a fallback)
//
// Built on KAPLAY (vendored in /vendor), the maintained successor to Kaboom.
// It supplies gravity, collisions, sprites and the scene graph; the only
// bespoke part is the input layer.
//
// DESIGN NOTE — why the player doesn't move horizontally under gaze control:
// the eyes have three usable states here (up / neutral / down), which is not
// enough to steer AND jump AND duck. So the world scrolls at a constant rate
// and the player only controls vertical action. That is also what makes it
// playable at Neon's ~70px accuracy: the input is three big screen bands, not
// a precise position.
(function () {
  const k = kaplay({
    global: false,
    canvas: document.getElementById("game"),
    background: [8, 9, 14],
    crisp: true,
  });
  // Debug handle: kaplay runs `global:false` so nothing else can reach the
  // instance, which makes a blank canvas impossible to inspect from a console.
  window.__oculus = k;

  // ---------------------------------------------------------------- tuning
  const GROUND_Y = () => k.height() - 90;
  const SPEED = 260;          // world scroll, px/s
  const JUMP_FORCE = 780;
  const BULLET_SPEED = 620;
  const SHOOT_COOLDOWN = 0.28;
  const RED = [255, 59, 59];
  const BONE = [232, 230, 226];

  let score = 0;
  let best = Number(localStorage.getItem("oculusrun.best") || 0);

  // ------------------------------------------------------------ input glue
  // GazeActions turns the gaze stream into up/neutral/down + blink events.
  // Keyboard mirrors every control so the game is testable without a headset.
  function wireInput(scene) {
    const jump = () => scene.onJump && scene.onJump();
    const duck = (on) => scene.onDuck && scene.onDuck(on);
    const shoot = () => scene.onShoot && scene.onShoot();

    if (window.GazeActions) {
      GazeActions.on("zone", (z) => {
        if (z === GazeActions.UP) { jump(); duck(false); }
        else if (z === GazeActions.DOWN) duck(true);
        else duck(false);
      });
      GazeActions.on("blink", shoot);
    }
    k.onKeyPress("up", jump);
    k.onKeyPress("space", jump);
    k.onKeyDown("down", () => duck(true));
    k.onKeyRelease("down", () => duck(false));
    k.onKeyPress("x", shoot);
  }

  // ------------------------------------------------------------------ game
  k.scene("play", () => {
    score = 0;
    let lastShot = 0;
    let ducking = false;

    // Ground
    k.add([
      k.rect(k.width(), 120),
      k.pos(0, GROUND_Y() + 30),
      k.color(18, 20, 26),
      k.area(),
      k.body({ isStatic: true }),
      k.fixed(),
      "ground",
    ]);
    k.add([k.rect(k.width(), 2), k.pos(0, GROUND_Y() + 30), k.color(...RED), k.opacity(0.5), k.fixed()]);

    const player = k.add([
      k.rect(34, 48),
      k.pos(140, GROUND_Y() - 60),
      k.color(...BONE),
      k.area(),
      k.body(),
      k.anchor("botleft"),
      "player",
    ]);

    // A pupil-ish mark so the avatar reads as an eye, matching Medusa.
    const iris = k.add([
      k.circle(7), k.color(...RED), k.pos(0, 0), k.anchor("center"), k.z(10),
    ]);
    player.onUpdate(() => iris.pos = k.vec2(player.pos.x + 17, player.pos.y - (ducking ? 16 : 30)));

    // Ducking shrinks the hitbox — that is the whole point of the control, so
    // it must change collisions, not just the sprite.
    function setDuck(on) {
      if (on === ducking) return;
      ducking = on;
      player.height = on ? 24 : 48;
      player.area.shape = new k.Rect(k.vec2(0), 34, on ? 24 : 48);
    }

    const scene = {
      onJump() { if (player.isGrounded()) player.jump(JUMP_FORCE); },
      onDuck(on) { setDuck(on); },
      onShoot() {
        if (k.time() - lastShot < SHOOT_COOLDOWN) return;
        lastShot = k.time();
        k.add([
          k.rect(14, 4),
          k.pos(player.pos.x + 34, player.pos.y - (ducking ? 14 : 28)),
          k.color(...RED),
          k.area(),
          k.move(k.RIGHT, BULLET_SPEED),
          k.offscreen({ destroy: true }),
          "bullet",
        ]);
      },
    };
    wireInput(scene);

    // -------------------------------------------------------- obstacles
    // Two kinds, one per control: a low block you JUMP, and a high bar you
    // DUCK under. Shooting clears either.
    function spawn() {
      const high = k.rand() > 0.5;
      k.add([
        k.rect(30, high ? 26 : 44),
        k.pos(k.width() + 30, high ? GROUND_Y() - 62 : GROUND_Y() + 30),
        k.color(120, 30, 30),
        k.outline(2, k.rgb(...RED)),
        k.area(),
        k.anchor(high ? "botleft" : "botleft"),
        k.move(k.LEFT, SPEED),
        k.offscreen({ destroy: true }),
        "obstacle",
      ]);
      k.wait(k.rand(0.9, 1.8), spawn);
    }
    k.wait(1, spawn);

    k.onCollide("bullet", "obstacle", (b, o) => {
      k.destroy(b); k.destroy(o);
      score += 3;
      k.addKaboom(o.pos);
    });
    player.onCollide("obstacle", () => {
      best = Math.max(best, score);
      localStorage.setItem("oculusrun.best", String(best));
      k.go("dead");
    });

    k.onUpdate(() => {
      if (window.Tracking) Tracking.update();
      if (window.GazeActions) GazeActions.update();
      score += k.dt() * 4;
    });

    // ------------------------------------------------------------- HUD
    const hud = k.add([k.text("", { size: 16 }), k.pos(16, 14), k.color(...BONE), k.fixed()]);
    hud.onUpdate(() => {
      const z = window.GazeActions ? GazeActions.zone() : 0;
      const zname = z < 0 ? "UP" : z > 0 ? "DOWN" : "—";
      hud.text = `SCORE ${Math.floor(score)}   BEST ${Math.floor(best)}   GAZE ${zname}`;
    });

    // Band guides: without them a player has no idea where "up" begins, and
    // the whole control scheme feels arbitrary.
    const bands = window.GazeActions ? GazeActions.bands : { upEdge: 0.34, downEdge: 0.66 };
    k.add([k.rect(k.width(), 1), k.pos(0, k.height() * bands.upEdge), k.color(...RED), k.opacity(0.18), k.fixed()]);
    k.add([k.rect(k.width(), 1), k.pos(0, k.height() * bands.downEdge), k.color(...RED), k.opacity(0.18), k.fixed()]);
    k.add([k.text("look above this line to JUMP", { size: 11 }),
           k.pos(k.width() - 12, k.height() * bands.upEdge - 16), k.anchor("botright"),
           k.color(...RED), k.opacity(0.5), k.fixed()]);
    k.add([k.text("look below this line to DUCK", { size: 11 }),
           k.pos(k.width() - 12, k.height() * bands.downEdge + 6), k.anchor("topright"),
           k.color(...RED), k.opacity(0.5), k.fixed()]);
  });

  k.scene("dead", () => {
    k.add([k.text("PETRIFIED", { size: 44 }), k.pos(k.center().sub(0, 40)), k.anchor("center"), k.color(...RED)]);
    k.add([k.text(`score ${Math.floor(score)}    best ${Math.floor(best)}`, { size: 18 }),
           k.pos(k.center().add(0, 16)), k.anchor("center"), k.color(...BONE)]);
    k.add([k.text("blink or press space to run again", { size: 13 }),
           k.pos(k.center().add(0, 56)), k.anchor("center"), k.color(140, 140, 140)]);
    const restart = () => k.go("play");
    k.onKeyPress("space", restart);
    if (window.GazeActions) GazeActions.on("blink", () => { if (k.getSceneName?.() !== "play") restart(); });
    k.onUpdate(() => { if (window.Tracking) Tracking.update(); if (window.GazeActions) GazeActions.update(); });
  });

  // The gaze stack dismisses its overlay once calibration finishes; start the
  // game then so the player isn't dodging obstacles behind a boot screen.
  function begin() {
    if (window.GazeActions) GazeActions.start();
    // Kaplay swallows exceptions thrown inside a scene body and leaves a
    // blank canvas with nothing in the console, which is a miserable way to
    // debug. Surface them.
    try {
      k.go("play");
    } catch (err) {
      console.error("[oculus-run] scene failed:", err);
      throw err;
    }
  }
  if (window.__gazeReady) begin();
  else window.addEventListener("gaze-ready", begin, { once: true });

  // Mouse/keyboard-only players never get a gaze-ready event, so don't leave
  // them staring at a blank canvas.
  setTimeout(() => { if (k.getSceneName?.() == null) begin(); }, 1200);
})();
