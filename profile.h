#ifndef PROFILE_H
#define PROFILE_H

#include "peak_eq.h"
#include "config.h"

struct BandProfile {
    float freqHz;   // Centre frequency in Hz
    float Q;        // Quality factor
    float gainDB;   // Gain: positive = boost, negative = cut, 0 = flat
};

extern const BandProfile DEFAULT_PROFILE[NUM_BANDS];

#endif // PROFILE_H
