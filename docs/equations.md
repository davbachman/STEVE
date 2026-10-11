# Equations and Local Definitions

[Documentation home](../README.md) · [Open ST.E.V.E.](https://davbachman.github.io/STEVE/)

| Object or form | What to enter | Example |
| --- | --- | --- |
| Curve → Parametric | A 3-tuple using `t` | `(cos(t), sin(t), 0.2*t)` |
| Surface → Graph | A function of `x` and `y`; `z=` is supplied | `x^2 - y^2` |
| Surface → Parametric | A 3-tuple using `u` and `v` | `((2+0.7*cos(v))*cos(u), (2+0.7*cos(v))*sin(u), 0.7*sin(v))` |
| Surface → Implicit | An equality involving `x`, `y`, and/or `z` | `x^2 + y^2 + z^2 = 4` |
| Explicit surface | An equality solved for one axis | `x = y^2 + z^2`, `y = sin(x) + z`, or `z = x*y` |

Graph objects intentionally accept only the `f(x,y)` shorthand. To enter a full `x=`, `y=`, or `z=` equation, start with a non-Graph plot—for example **Surface → Parametric**—and replace its equation. ST.E.V.E. reclassifies the object automatically.

## Syntax

The equation language supports:

- Operators: `+`, `-`, `*`, `/`, and `^`.
- Constants: `pi` and `e`.
- Functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `sinh`, `cosh`, `tanh`, `exp`, `log`, `ln`, `sqrt`, and `abs`. `log` is base 10; `ln` is natural log.
- Adjustable constants: free names such as `a`, `b`, or `c` become controls under **Object → Constants**. A name defined in the equation block is calculated from its definition and does not get a slider.

Powers bind before a leading sign: `-x^2` means `-(x^2)`, while `(-x)^2` squares the negative value. Negative exponents are supported (`2^-2 = 0.25`), and power chains group from the right (`2^3^2 = 512`).

## Multiline definitions

Write one or more local scalar definitions before the final plot expression. For example, choose **Curve → + Parametric** and paste:

```text
A = 2 + cos(3*t)
(A*cos(t), A*sin(t), sin(3*t))
```

Set the `t` bounds to `0` and `2*pi`. `A` is evaluated at each sampled `t` and reused in both coordinates. The final statement determines the plot; earlier statements define values available to it.

Definitions work with every supported equation type:

| Type | Definition on an earlier line | Final statement |
| --- | --- | --- |
| Parametric curve | `A = 2 + cos(3*t)` | `(A*cos(t), A*sin(t), sin(3*t))` |
| Parametric surface | `R = 2 + 0.7*cos(v)` | `(R*cos(u), R*sin(u), 0.7*sin(v))` |
| Explicit z surface | `A = x^2 + y^2` | `z = sin(A)` |
| Explicit x surface | `A = y^2 + z^2` | `x = sin(A)` |
| Explicit y surface | `A = x^2 + z^2` | `y = sin(A)` |
| Implicit surface | `A = x^2 + y^2 + z^2` | `A = r^2` |
| Graph | `A = x^2 + y^2` | `sin(A)` |

Each table row is a separate example: put the definition and final statement on separate lines in one object's editor. In the implicit example, the final `A = r^2` is the equation being plotted, and `r` is an adjustable constant. Graph objects still supply `z =` automatically; their final statement must be a function expression.

### Chained definitions and sliders

Definitions may use earlier definitions and adjustable constants:

```text
A = a*sin(t)
B = A^2
(B*cos(t), B*sin(t), A)
```

Here `a` gets a slider and can be animated or sampled as a discrete family. `A` and `B` are derived values and have no sliders. Adding `a = 3` before these lines fixes `a` at 3 and removes its slider. See [Constants, Animation, and GIFs](animation.md) for the controls.

### Definition rules

- Definitions are local to the current plot object. Reusing a name in another object does not link the objects.
- Names are case-sensitive: `A` and `a` are different. Names begin with a letter or underscore and may include digits or underscores, such as `R_1`.
- Define a name before using it in another definition. Duplicate definitions, self-references, forward references, and circular references are rejected.
- Coordinate names `x`, `y`, `z`, `t`, `u`, and `v`, the constants `pi` and `e`, and built-in function names cannot be redefined.
- Each definition must produce a scalar value. User-defined functions such as `f(t) = ...` and tuple-valued definitions are not supported.
- Blank lines are allowed. Wrap a long expression in parentheses to continue it across lines. The final *statement*, even when wrapped, remains the plot expression.
- Only definitions used by the final plot, directly or through other definitions, affect its type and slider list. Unused definitions are still checked for invalid syntax and references.

### Collapsing the editor

Click **Collapse** at the top right of the equation editor to hide both the source and math preview. A compact bar keeps the line count and **Expand** button visible. Click **Expand** to resume editing; collapsing preserves the equation and keeps the plot visible.

The expanded editor has a limited height and scrolls, so long definitions cannot consume the whole drawing area. Scroll inside it to reach later lines and the math preview. Multiline input shows line numbers, and autocomplete suggests earlier local definitions.

## Diagnostics and numeric fields

Curves and parametric/explicit surfaces leave gaps across detected undefined regions and discontinuities, such as the pole of `1/x`, instead of joining them with lines or triangles. Intermediate samples distinguish poles from steep continuous slopes. This is a numerical check: extremely narrow singularities or rapid oscillations can still fall between samples.

Click the `ƒx` button beside the editor for the in-app syntax reference. Numeric inspector fields also accept expressions such as `pi/2` and `sqrt(2)`; press `Enter` or leave the field to apply a typed value.

Incomplete or invalid equations show an explanation beneath the editor and underline the problem. If an earlier valid plot remains visible, the viewport identifies it as **Showing last valid equation**.

---

[Previous: Getting Started](getting-started.md) · [Table of contents](../README.md#table-of-contents) · [Next: Constants, Animation, and GIFs](animation.md)
