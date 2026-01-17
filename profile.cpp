#include "profile.h"
#include <Arduino.h>

// ============================================================================
// profile.cpp
//
// Provides the default hearing-aid EQ profile and the utility functions that
// load it into a BandProfile array and build the corresponding PeakEQ filters.
// ============================================================================

// ----------------------------------------------------------------------------
// DEFAULT_PROFILE
//
// Six bands covering the core speech and hearing range.
// Gains model typical high-frequency sensorineural hearing loss:
//   - Mild bass boost at 250 / 500 Hz for warmth
//   - Flat at 1000 Hz (reference)
//   - Slight cut at 2000 Hz to reduce harshness
//   - Strong boost at 4000 / 8000 Hz where most hearing loss occurs
// ----------------------------------------------------------------------------
const BandProfile DEFAULT_PROFILE[NUM_BANDS] = {
    {  250.0f, 1.2f,  6.0f },   // Band 0 — 250 Hz,  +6 dB
    {  500.0f, 1.3f,  4.0f },   // Band 1 — 500 Hz,  +4 dB
    { 1000.0f, 1.4f,  0.0f },   // Band 2 — 1 kHz,    0 dB (reference)
    { 2000.0f, 1.5f, -2.0f },   // Band 3 — 2 kHz,   -2 dB
    { 4000.0f, 1.6f,  7.0f },   // Band 4 — 4 kHz,   +7 dB
    { 8000.0f, 1.8f, 10.0f },   // Band 5 — 8 kHz,  +10 dB
};

// ----------------------------------------------------------------------------
// loadDefaultProfile
// ----------------------------------------------------------------------------
void loadDefaultProfile(BandProfile *profile) {
    for (int i = 0; i < NUM_BANDS; i++) {
        profile[i] = DEFAULT_PROFILE[i];
    }
}

// ----------------------------------------------------------------------------
// buildFilters
//
// Converts a BandProfile array into a ready-to-use PeakEQ filter bank.
// Each call to createPeakEQ() zeroes the delay states, so any previous
// filter history is discarded — call this after calibration or gain changes.
// ----------------------------------------------------------------------------
void buildFilters(const BandProfile *profile, PeakEQ *eqBands) {
    for (int i = 0; i < NUM_BANDS; i++) {
        eqBands[i] = createPeakEQ(
            profile[i].freqHz,
            profile[i].Q,
            profile[i].gainDB,
            SAMPLE_RATE
        );
    }
}

// ----------------------------------------------------------------------------
// printProfile
// ----------------------------------------------------------------------------
void printProfile(const BandProfile *profile) {
    Serial.println(F("+---------+-----------+-----+---------+"));
    Serial.println(F("| Band    | Freq (Hz) |  Q  | Gain dB |"));
    Serial.println(F("+---------+-----------+-----+---------+"));
    for (int i = 0; i < NUM_BANDS; i++) {
        Serial.print(F("|   "));
        Serial.print(i);
        Serial.print(F("     |   "));
        // Right-align frequency (up to 5 chars)
        float f = profile[i].freqHz;
        if (f < 1000.0f) Serial.print(F("  "));
        else if (f < 10000.0f) Serial.print(F(" "));
        Serial.print(f, 0);
        Serial.print(F("   | "));
        Serial.print(profile[i].Q, 1);
        Serial.print(F(" |  "));
        if (profile[i].gainDB >= 0.0f) Serial.print(F("+"));
        Serial.print(profile[i].gainDB, 1);
        Serial.println(F("   |"));
    }
    Serial.println(F("+---------+-----------+-----+---------+"));
}
