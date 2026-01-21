#include "audio_pipeline.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>

void AudioEQStream::loadProfile(const BandProfile *profile) {
    PeakEQ newBands[NUM_BANDS];
    for (int i = 0; i < NUM_BANDS; i++) {
        newBands[i] = createPeakEQ(
            profile[i].freqHz,
            profile[i].Q,
            profile[i].gainDB,
            SAMPLE_RATE
        );
    }

    noInterrupts();
    for (int i = 0; i < NUM_BANDS; i++) {
        _profile[i] = profile[i];
        _eqBands[i] = newBands[i];
    }
    interrupts();
}

void AudioEQStream::setGain(int band, float gainDB) {
    if (band < 0 || band >= NUM_BANDS) return;

    PeakEQ updated = createPeakEQ(
        _profile[band].freqHz,
        _profile[band].Q,
        gainDB,
        SAMPLE_RATE
    );

    noInterrupts();
    _profile[band].gainDB = gainDB;
    _eqBands[band]        = updated;
    interrupts();
}

void AudioEQStream::getProfile(BandProfile *profile) const {
    noInterrupts();
    for (int i = 0; i < NUM_BANDS; i++) {
        profile[i] = _profile[i];
    }
    interrupts();
}
