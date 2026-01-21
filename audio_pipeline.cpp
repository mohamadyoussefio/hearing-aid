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

float AudioEQStream::_runEQ(float x) {
    for (int i = 0; i < NUM_BANDS; i++) {
        x = processPeakEQ(_eqBands[i], x);
    }
    return x;
}

void AudioEQStream::update() {
    audio_block_t *inBlock = receiveReadOnly(0);
    if (!inBlock) return;

    audio_block_t *outBlock = allocate();
    if (!outBlock) {
        release(inBlock);
        return;
    }

    for (int i = 0; i < AUDIO_BLOCK_SAMPLES; i++) {
        float x = (float)inBlock->data[i] / 32768.0f;
        float y = _runEQ(x);

        if (y > MAX_OUTPUT) {
            y = MAX_OUTPUT;
        } else if (y < -MAX_OUTPUT) {
            y = -MAX_OUTPUT;
        }

        outBlock->data[i] = (int16_t)(y * 32767.0f);
    }

    release(inBlock);
    transmit(outBlock);
    release(outBlock);
}
