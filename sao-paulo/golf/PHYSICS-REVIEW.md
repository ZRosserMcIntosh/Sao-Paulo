# Golf Ball Aerodynamics: physics review

A line-by-line review of the models in `physics.js` and the way `golf.js`
uses them. Each part was checked against equations from first principles,
against published measurements, or against conservation laws. Where the
review found an error it was fixed, and the fix is recorded here.
`node sao-paulo/golf/validate.mjs` re-runs every numerical check (61 checks,
all passing).

The reference data is the TrackMan PGA Tour averages for eight clubs. For
each club these give club speed, attack angle, ball speed, launch angle,
spin, apex, landing angle and carry. They are the best large-sample record of
real golf shots, and they test the impact model and the flight model
separately.

## 1. Constants

| Quantity | Value | Verdict |
|---|---|---|
| Ball diameter | 42.67 mm | Correct (Rules of Golf minimum) |
| Ball mass | 45.93 g | Correct (Rules of Golf maximum) |
| Air density ρ | 1.225 kg/m³ | ISA sea level, 15 °C |
| Kinematic viscosity ν | 1.5×10⁻⁵ m²/s | 1.46×10⁻⁵ at 15 °C; a 3% difference, well inside the drag-curve uncertainty |
| g | 9.81 m/s² | Correct |
| Ball moment of inertia | (2/5) m r² | A solid sphere. Real multi-layer balls are 0.38–0.40 m r². Kept, and noted |

## 2. Flight model

**Equations.** The ball is a point mass in the vertical plane with drag along
−V̂, Magnus lift perpendicular to V̂ (rotated +90° for backspin) and gravity:

    dv/dt = (ρ A / 2m) V² (−C_d V̂ + C_l n̂) − g ŷ,   dω/dt = −ω/τ

The code writes this as `q(−Cd·ux − Cl·uy, −Cd·uy + Cl·ux) − g`, which is
correct: (−u_y, u_x) is V̂ rotated +90°. C_d and C_l are re-evaluated from
the current Re and S = ωr/V at every RK4 stage.

**Integration.** Classical RK4 with a 4 ms step. The landing point is found by
linear interpolation inside the last step. Halving the step changes carry by
less than 1 mm, so the integrator is converged.

**Findings, all fixed:**

1. **Lift was too high.** C_l = 0.54 S^0.4 with spin drag 0.18 S put every
   club's apex 5–10 yd above the TrackMan averages (driver 42 yd against 32).
   Irons carried 5–7% long. Driver carry was short at the same time, so the
   problem was not one constant. Refitting the same Smits & Smith power-law
   form to the eight clubs gives C_l = 0.47 S^0.42 and C_d = C_d0 + 0.26 S.
   That gives C_l = 0.18, 0.24 and 0.28 at S = 0.1, 0.2 and 0.3, which sits
   inside the published wind-tunnel scatter (Bearman & Harvey; Aoki et al.).
   The fit is therefore physically plausible and not just a curve match.
2. **Post-crisis drag rose with Re.** It went from 0.235 to 0.275 across the
   golf range, while the measurements (Choi, Jeon & Choi 2006) show it nearly
   flat. It is now flat at 0.221, fitted to the flights.
3. **S was clamped at 0.4.** That clamp silently capped lift for every wedge
   launch (S = 0.46) and for every ball near its apex, where S reaches about
   0.8 as the ball slows. The cap is now 1.0. The slider still warns beyond
   the fitted launch range of 0.46.
4. **Spin decay** (τ = 25 s) is an estimate. The fit is insensitive to it: the
   no-decay and τ = 25 s fits differ in the fourth decimal of the error, so
   it is kept and labelled as an estimate.

**Result.** Measured launch in, model flight out:

| Club | Carry (yd) | Apex (yd) | Landing angle |
|---|---|---|---|
| Driver | 263 vs 275 (−4.2%) | 35 vs 32 | 40° vs 37° |
| 3-wood | 245 vs 243 | 30 vs 30 | 39° vs 43° |
| 5-iron | 199 vs 194 | 28 vs 31 | 41° vs 47° |
| 6-iron | 188 vs 183 | 31 vs 30 | 45° vs 47° |
| 7-iron | 172 vs 172 | 31 vs 32 | 47° vs 50° |
| 8-iron | 159 vs 160 | 32 vs 31 | 49° vs 50° |
| 9-iron | 146 vs 148 | 32 vs 30 | 51° vs 51° |
| PW | 130 vs 136 (−4.7%) | 32 vs 29 | 53° vs 52° |

Before the fix, the summed squared error was 0.38. It is now 0.097.

The remaining pattern, with long clubs landing a few degrees shallow and the
ends of the range carrying about 4–5% short, is shared by every model family
tried: linear, power law, and Re-dependent drag. Likely causes include the
following, so it was not tuned further:

- Tour air is warmer and thinner than ISA.
- TrackMan's averages mix many balls and conditions.
- Lift really depends on Re as well as S.

## 3. Aerodynamic coefficients

- **Drag crisis.** A logistic blend in log Re between a subcritical sphere
  curve and the post-crisis value. The golf ball's crisis is at Re ≈ 5×10⁴
  (about 18 m/s), with drag falling from about 0.43 at 10 m/s to 0.22 by
  25 m/s, consistent with Choi et al. The smooth sphere's crisis is at
  3.3×10⁵, with a minimum near 0.07 (Achenbach 1972 places
  it at 3.6×10⁵, a close match). A smooth ball is therefore still
  subcritical at every golf speed, which is the page's central point.
- **Surface pressure** (the coloured skin). Its pressure-drag integral,
  C_d = 2 ∫ C_p sin θ cos θ dθ, is the correct axisymmetric form. The
  dimpled base pressure was re-tuned (−0.18 for the dimpled ball, from
  −0.20) so the integral matches the new C_d0 (0.221 against 0.221). The
  smooth ball gives 0.465 against 0.48. The minimum pressures, −0.45
  laminar and about −1.2 turbulent, sit between potential flow (−1.25) and
  Achenbach's measurements, as they should.
- **Separation angles.** 82° laminar, 113° dimpled and 120° smooth
  supercritical, all as published. The spin shift of up to ±20° and the wake
  width are estimates and are labelled as such.
- **Smooth-ball lift** at half the dimpled value is an estimate, as the page
  already says. The fitted spin-drag slope is also applied to the smooth
  ball, which is an estimate too.

## 4. The wind tunnel (2-D discrete-vortex flow)

The checks were made in non-dimensional units: ball radius 1, free stream 1.

- **Free stream plus doublet.** The complex velocity 1 − 1/z² gives
  u = 1 − (x² − y²)/r⁴ and v = −2xy/r⁴. Correct.
- **Bound circulation.** u = −Γy/(2πr²), v = Γx/(2πr²) for a
  counter-clockwise Γ. The code uses Γ = −C_l, which is clockwise for
  backspin and gives +y lift by Kutta–Joukowski. The sign is correct. Using
  the 3-D C_l as a 2-D circulation is a visual scaling, not a 2-D lift
  prediction, and the page labels the forces from the 3-D coefficients.
- **Images.** Each wake vortex has an opposite image at the inverse point
  z/|z|² (Milne-Thomson), so there is no flow through the ball. There is no
  compensating vortex at the centre, so the body carries the bound
  circulation minus the shed circulation. That is Kelvin's theorem,
  consistent.
- **Shedding.** dΓ/dt = ½ U_e² at the separation points, times 0.6. This is
  the standard reduction in the Clements / Sarpkaya class of models.
  Lamb–Oseen-like blob cores grow with age, the circulation decays, and
  midpoint (RK2) advection is used. This is all standard for prescribed-
  separation vortex methods.
- **Time.** Non-dimensional time is V t / R, and spin is the angle ω t. The
  ball turns clockwise on screen, which is backspin for a ball flying −x.
  Smoke and lift agree in sign.
- **Illustrative, labelled.** The small-scale noise, the dimple eddies in the
  close-up and the flat 2-D street. A real sphere wake is 3-D with helical
  loops.

The boundary-layer close-up uses Pohlhausen's quartic profile,
u/U = 2η − 2η³ + η⁴ + (Λ/6) η (1 − η)³, with Λ running from 7 down toward
the separation value −12. That is correct. The 1/7-power turbulent profile
and the flat-plate thicknesses (5x/√Re_x laminar, 0.37x/Re_x^0.2 turbulent)
are used with the potential-flow edge speed 1.5 V sin θ, as labelled
estimates.

## 5. The impact (new)

**Model.** A 2-D rigid-body oblique collision between the ball (m, r, I_b)
and the club head. The head has mass M and moment of inertia I_c about its
CG. The CG is a depth b behind the face, and the contact is h above it along
the face.

The impulse is P = J_n n + J_t t. The contact-point relative velocity changes
by K P, where

    K = [[1/m + 1/M + h²/I_c, −hb/I_c], [−hb/I_c, 1/m + 1/M + r²/I_b + b²/I_c]]

- **Normal direction:** the relative normal velocity reverses with
  restitution e_n.
- **Tangential direction:** the relative sliding velocity reverses with e_t.
  The ball grips, stores tangential elastic energy, and springs back
  (Cross 2002, 2005).
- **Friction limit:** a Coulomb limit |J_t| ≤ μ J_n.
- **Gear effect:** the coupling term −hb/I_c is the vertical gear effect.

**Why not the textbook model.** The classic model, where the ball "rolls off
the face" (e_t = 0, Penner 2003), was tested first. It under-spins every iron
by 25–36% and over-spins the driver by 45%. Measured iron spin requires
e_t ≈ 0.33. The driver's low tour spin requires the gear effect: its CG is
38 mm behind the face, and tour players strike high on the face.

**Calibrated parameters:**

- e_t = 0.33, one value for every club;
- e_n = 0.83 for the driver (the rules limit) and 0.78 for irons;
- contact height above the CG: 12 mm for the driver and 4 mm for irons;
- head mass, moment of inertia and CG depth taken as typical published
  values.

**Validation.** TrackMan club delivery in, dynamic loft solved for the
measured launch angle, then ball speed and spin predicted:

| Club | Ball speed (mph) | Spin (rpm) |
|---|---|---|
| 5-iron | 133 vs 132 | 5413 vs 5361 (+1%) |
| 7-iron | 121 vs 120 | 7005 vs 7097 (−1%) |
| 9-iron | 108 vs 109 | 8152 vs 8647 (−6%) |
| PW | 97 vs 102 | 9360 vs 9304 (+1%) |
| Driver | 160 vs 167 (−4%) | 3250 vs 2686 (+21%) |

The driver is a known residual. The model reaches the tour average only
with a strike about 15 mm above the CG, together with an implausibly high
restitution. Face bulge and roll, and the face's flex, are not modelled.

**Conservation checks** (in `validate.mjs`), for every club:

- linear momentum of ball plus head is conserved to 10⁻⁹;
- kinetic energy after impact is 94–95% of the club's, so none is created;
- friction does not saturate;
- with e_t = 0 and no CG offset, the model reproduces Penner's closed form
  ω = 5 v_t / 2r exactly.

**Contact.** The contact time is 0.45 ms at a 50 m/s normal approach, scaled
by v^−1/5 as Hertzian contact predicts. Measurements are about 0.45 ms. The
force follows the deflection: a quarter sine during compression over t_c,
and a quarter cosine during restitution over t_r = t_c/e_n, so the peak
deflection is the same and the exit speed is e_n times the approach.

The peak compression is δ_max = 2 v t_c / π: 6.4 mm for the driver and
4.8 mm for the 7-iron, the order seen in high-speed photographs.

**Presets.** These are the measured TrackMan launch conditions, so the flight
is the validated part. The impact model is inverted with a Newton solver to
find the club speed, attack angle and dynamic loft that deliver them. Hand-set
sliders are solved the same way. The no-spin shot needs the club moving 6°
upward with the face square to its path, which is physically the only way to
strike a knuckleball.

## 6. The shot timeline

`shot.t` is real time from first contact.

- **Start.** Every shot (page load, Restart, presets) starts at first
  contact. The club itself is not drawn; its effect is the ball's
  deformation and launch.
- **Contact.** It plays at true speed: 0.9 s on screen at 1/2000× and
  0.11 s at 1/250×.
- **The flow.** The air past the ball is zero before contact. During the
  contact it ramps with the delivered impulse, so the tunnel's
  non-dimensional time is ∫ u dt / R. That is exact for the quasi-steady
  potential flow and approximate for the wake, which is an impulsively
  started sphere growing from nothing.
- **Before the strike.** The smoke hangs still.

The clock reads, in turn: compressing, restoring, in flight.

## 7. What remains approximate

- The flight is 2-D. There is no sidespin, wind or temperature correction.
  Rolling after landing is not modelled.
- The driver impact over-spins by about 20%, as described above.
- The cross-section flow is 2-D, as the page states, and real dimples are
  not resolved.
- The ball's real multi-layer moment of inertia is about 4% below the solid
  sphere.
