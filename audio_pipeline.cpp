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

void AudioPipeline::_applyModeToHardware(DebugMode mode) {
    switch (mode) {
        case DebugMode::NORMAL:
            inputMixer.gain(0, 1.0f);
            inputMixer.gain(1, 0.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(false);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::PASSTHROUGH:
            inputMixer.gain(0, 1.0f);
            inputMixer.gain(1, 0.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::TONE:
            inputMixer.gain(0, 0.0f);
            inputMixer.gain(1, 1.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(false);
            eqStream.setAdcPrint(false);
            break;

        case DebugMode::ADC_PRINT:
            inputMixer.gain(0, 1.0f);
            inputMixer.gain(1, 0.0f);
            inputMixer.gain(2, 0.0f);
            inputMixer.gain(3, 0.0f);
            eqStream.setBypassed(true);
            eqStream.setSilent(true);
            eqStream.setAdcPrint(true);
            break;
    }
}

void AudioPipeline::init() {
    sgtl5000.enable();
    sgtl5000.volume(SGTL5000_VOLUME);
    sgtl5000.inputSelect(AUDIO_INPUT);
    sgtl5000.micGain(SGTL5000_MIC_GAIN);

    BandProfile defaultProfile[NUM_BANDS];
    loadDefaultProfile(defaultProfile);
    eqStream.loadProfile(defaultProfile);

    toneGen.frequency(1000.0f);
    toneGen.amplitude(0.0f);

    _applyModeToHardware(_debugMode);
}

void AudioPipeline::setGain(int band, float gainDB) {
    if (band < 0 || band >= NUM_BANDS) return;
    eqStream.setGain(band, gainDB);

    Serial.print(F("ACK  band="));
    Serial.print(band);
    Serial.print(F("  gain="));
    Serial.print(gainDB, 1);
    Serial.println(F(" dB"));
}

void AudioPipeline::loadProfile(const BandProfile *profile) {
    eqStream.loadProfile(profile);
}

void AudioPipeline::getProfile(BandProfile *profile) const {
    eqStream.getProfile(profile);
}

void AudioPipeline::setToneParams(float freqHz, float amplitude) {
    toneGen.frequency(freqHz);
    toneGen.amplitude((_debugMode == DebugMode::TONE) ? amplitude : 0.0f);
}

void AudioPipeline::setDebugMode(DebugMode mode) {
    _debugMode = mode;
    _applyModeToHardware(mode);
}
