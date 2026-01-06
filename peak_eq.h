#ifndef PEAK_EQ_H
#define PEAK_EQ_H

// ============================================================================
// peak_eq.h
// RBJ Audio EQ Cookbook — Peak EQ biquad filter.
// ============================================================================

struct PeakEQ {
    float b0, b1, b2;
    float a1, a2;
    float z1, z2;
};

PeakEQ createPeakEQ(float f0, float Q, float gainDB, float fs);
float processPeakEQ(PeakEQ &eq, float x);
void resetPeakEQ(PeakEQ &eq);

#endif // PEAK_EQ_H
