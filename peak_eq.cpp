#include "peak_eq.h"
#include <math.h>

// ============================================================================
// peak_eq.cpp
//
// RBJ Audio EQ Cookbook — Peak EQ biquad implementation.
//
// createPeakEQ() computes the five normalised biquad coefficients using the
// standard RBJ Peak EQ formulae:
//
//   A     = 10^(gainDB / 40)          linear gain factor
//   w0    = 2*pi*f0 / fs              digital centre frequency (radians/sample)
//   alpha = sin(w0) / (2*Q)           bandwidth parameter
//
//   b0 =  1 + alpha*A      b1 = -2*cos(w0)      b2 = 1 - alpha*A
//   a0 =  1 + alpha/A      a1 = -2*cos(w0)      a2 = 1 - alpha/A
//
// All five output coefficients are divided by a0 so the denominator is monic
// (a0 = 1 implicitly), which is the form expected by processPeakEQ().
//
// Special cases:
//   gainDB = 0  → A = 1  → b0/a0 = 1, b2/a2 cancel perfectly → unity gain
//   Q → ∞       → alpha → 0  → degenerate, but Q values used here are safe
// ============================================================================

// ----------------------------------------------------------------------------
// createPeakEQ
// ----------------------------------------------------------------------------
PeakEQ createPeakEQ(float f0, float Q, float gainDB, float fs) {
    PeakEQ eq;

    // Linear gain: A = 10^(dB/40)
    // Dividing the exponent by 40 (not 20) because the gain appears in both
    // the numerator and denominator — the effective amplitude gain is A^2 = 10^(dB/20).
    float A     = powf(10.0f, gainDB / 40.0f);

    // Digital centre frequency in radians per sample
    float w0    = 2.0f * (float)M_PI * f0 / fs;

    // Pre-compute sin and cos once — used in multiple terms
    float sinw0 = sinf(w0);
    float cosw0 = cosf(w0);

    // Bandwidth parameter
    float alpha = sinw0 / (2.0f * Q);

    // Raw (un-normalised) coefficients
    float b0_raw =  1.0f + alpha * A;
    float b1_raw = -2.0f * cosw0;
    float b2_raw =  1.0f - alpha * A;
    float a0_raw =  1.0f + alpha / A;
    float a1_raw = -2.0f * cosw0;
    float a2_raw =  1.0f - alpha / A;

    // Normalise by a0 so the filter is in monic form
    float inv_a0 = 1.0f / a0_raw;

    eq.b0 = b0_raw * inv_a0;
    eq.b1 = b1_raw * inv_a0;
    eq.b2 = b2_raw * inv_a0;
    eq.a1 = a1_raw * inv_a0;
    eq.a2 = a2_raw * inv_a0;

    // Zero delay states — filter starts with no memory
    eq.z1 = 0.0f;
    eq.z2 = 0.0f;

    return eq;
}

// ----------------------------------------------------------------------------
// processPeakEQ
//
// Direct Form II Transposed:
//
//   y    = b0*x + z1
//   z1   = b1*x - a1*y + z2
//   z2   = b2*x - a2*y
//
// This form is preferred over Direct Form I because it uses only two delay
// elements (minimum storage) and has better numerical properties since the
// intermediate signal y is already scaled by b0 before accumulation.
// ----------------------------------------------------------------------------
float processPeakEQ(PeakEQ &eq, float x) {
    float y  = eq.b0 * x + eq.z1;
    eq.z1    = eq.b1 * x - eq.a1 * y + eq.z2;
    eq.z2    = eq.b2 * x - eq.a2 * y;
    return y;
}

// ----------------------------------------------------------------------------
// resetPeakEQ
// ----------------------------------------------------------------------------
void resetPeakEQ(PeakEQ &eq) {
    eq.z1 = 0.0f;
    eq.z2 = 0.0f;
}
