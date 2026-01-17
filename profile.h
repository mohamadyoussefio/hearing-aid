#ifndef PROFILE_H
#define PROFILE_H

// ============================================================================
// profile.h
//
// Defines the BandProfile struct that describes one EQ band (frequency, Q,
// and gain), the default hearing-aid profile, and the functions that load and
// apply a profile to the PeakEQ filter bank.
// ============================================================================

#include "peak_eq.h"
#include "config.h"

// ----------------------------------------------------------------------------
// BandProfile
//
// Describes the target characteristics of a single EQ band.
// One array of NUM_BANDS BandProfile entries makes a complete hearing profile.
// ----------------------------------------------------------------------------
struct BandProfile {
    float freqHz;   // Centre frequency in Hz
    float Q;        // Quality factor (higher = narrower peak)
    float gainDB;   // Gain: positive = boost, negative = cut, 0 = flat
};

// ----------------------------------------------------------------------------
// DEFAULT_PROFILE
//
// A general-purpose starting profile modelling common high-frequency hearing
// loss.  Used automatically when no calibration has been run.
//
// Band index | Frequency | Q   | Gain
// -----------+-----------+-----+------
//     0      |   250 Hz  | 1.2 |  +6 dB
//     1      |   500 Hz  | 1.3 |  +4 dB
//     2      |  1000 Hz  | 1.4 |   0 dB
//     3      |  2000 Hz  | 1.5 |  -2 dB
//     4      |  4000 Hz  | 1.6 |  +7 dB
//     5      |  8000 Hz  | 1.8 | +10 dB
// ----------------------------------------------------------------------------
extern const BandProfile DEFAULT_PROFILE[NUM_BANDS];

// ----------------------------------------------------------------------------
// loadDefaultProfile
//
// Copy the DEFAULT_PROFILE table into the caller-supplied array.
// Call this during initialisation before any calibration has been run.
//
//  profile — output array of NUM_BANDS BandProfile entries (caller allocates)
// ----------------------------------------------------------------------------
void loadDefaultProfile(BandProfile *profile);

// ----------------------------------------------------------------------------
// buildFilters
//
// Create a PeakEQ filter for every band in the profile and store the results
// in eqBands.  Delay states are zeroed by createPeakEQ().
//
//  profile  — input array of NUM_BANDS BandProfile entries
//  eqBands  — output array of NUM_BANDS PeakEQ filters (caller allocates)
// ----------------------------------------------------------------------------
void buildFilters(const BandProfile *profile, PeakEQ *eqBands);

// ----------------------------------------------------------------------------
// printProfile
//
// Print a human-readable summary of every band to the Arduino Serial port.
// Safe to call from loop(); never call from an ISR.
// ----------------------------------------------------------------------------
void printProfile(const BandProfile *profile);

#endif // PROFILE_H
