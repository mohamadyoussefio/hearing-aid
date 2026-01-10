#ifndef PEAK_EQ_H
#define PEAK_EQ_H

// ============================================================================
// peak_eq.h
//
// RBJ Audio EQ Cookbook — Peak EQ biquad filter.
// Direct Form II Transposed implementation.
//
// Reference:
//   "Cookbook formulae for audio equalizer biquad filter coefficients"
//   Robert Bristow-Johnson
//   https://webaudio.github.io/Audio-EQ-Cookbook/audio-eq-cookbook.html
//
// Transfer function (z-domain, normalised so a0 = 1):
//
//         b0 + b1*z^-1 + b2*z^-2
//  H(z) = -----------------------
//          1 + a1*z^-1 + a2*z^-2
//
// Difference equation (Direct Form II Transposed):
//   y[n] = b0*x[n] + z1[n-1]
//   z1   = b1*x[n] - a1*y[n] + z2[n-1]
//   z2   = b2*x[n] - a2*y[n]
// ============================================================================

// ----------------------------------------------------------------------------
// PeakEQ
// Holds both the biquad coefficients and the two delay-line state variables.
// One instance per frequency band.
// ----------------------------------------------------------------------------
struct PeakEQ {
    // Normalised biquad coefficients (a0 divided out)
    float b0 = 1.0f, b1 = 0.0f, b2 = 0.0f;   // numerator
    float a1 = 0.0f, a2 = 0.0f;               // denominator (a0 = 1 implicitly)

    // Direct Form II Transposed delay states
    // Initialised to 0 by createPeakEQ() and resetPeakEQ().
    float z1 = 0.0f, z2 = 0.0f;
};

// ----------------------------------------------------------------------------
// createPeakEQ
//
// Compute RBJ Peak EQ coefficients and return a ready-to-use PeakEQ.
// Delay states are zeroed.
//
//  f0     — centre frequency in Hz  (0 < f0 < fs/2)
//  Q      — quality factor          (bandwidth control; higher Q = narrower peak)
//  gainDB — boost (+dB) or cut (-dB) at f0; 0 dB produces a unity-gain filter
//  fs     — sample rate in Hz       (e.g. 44100)
// ----------------------------------------------------------------------------
PeakEQ createPeakEQ(float f0, float Q, float gainDB, float fs);

// ----------------------------------------------------------------------------
// processPeakEQ
//
// Process one audio sample through the filter and return the filtered output.
// Updates the delay states z1 and z2 in place.
//
//  eq — filter instance (modified in place)
//  x  — input sample, normalised to [-1.0, +1.0]
// ----------------------------------------------------------------------------
float processPeakEQ(PeakEQ &eq, float x);

// ----------------------------------------------------------------------------
// resetPeakEQ
//
// Zero the delay states of a filter without changing its coefficients.
// Call this when switching modes to prevent start-up clicks from stale state.
// ----------------------------------------------------------------------------
void resetPeakEQ(PeakEQ &eq);

#endif // PEAK_EQ_H
