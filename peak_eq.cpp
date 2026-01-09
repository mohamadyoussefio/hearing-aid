#include "peak_eq.h"
#include <math.h>

// ============================================================================
// peak_eq.cpp — RBJ Audio EQ Cookbook Peak EQ biquad implementation.
// ============================================================================

PeakEQ createPeakEQ(float f0, float Q, float gainDB, float fs) {
    PeakEQ eq;

    float A     = powf(10.0f, gainDB / 40.0f);
    float w0    = 2.0f * (float)M_PI * f0 / fs;
    float sinw0 = sinf(w0);
    float cosw0 = cosf(w0);
    float alpha = sinw0 / (2.0f * Q);

    float b0_raw =  1.0f + alpha * A;
    float b1_raw = -2.0f * cosw0;
    float b2_raw =  1.0f - alpha * A;
    float a0_raw =  1.0f + alpha / A;
    float a1_raw = -2.0f * cosw0;
    float a2_raw =  1.0f - alpha / A;

    float inv_a0 = 1.0f / a0_raw;

    eq.b0 = b0_raw * inv_a0;
    eq.b1 = b1_raw * inv_a0;
    eq.b2 = b2_raw * inv_a0;
    eq.a1 = a1_raw * inv_a0;
    eq.a2 = a2_raw * inv_a0;

    eq.z1 = 0.0f;
    eq.z2 = 0.0f;

    return eq;
}

float processPeakEQ(PeakEQ &eq, float x) {
    float y  = eq.b0 * x + eq.z1;
    eq.z1    = eq.b1 * x - eq.a1 * y + eq.z2;
    eq.z2    = eq.b2 * x - eq.a2 * y;
    return y;
}

void resetPeakEQ(PeakEQ &eq) {
    eq.z1 = 0.0f;
    eq.z2 = 0.0f;
}
