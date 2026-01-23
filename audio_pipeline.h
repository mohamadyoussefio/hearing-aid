#ifndef AUDIO_PIPELINE_H
#define AUDIO_PIPELINE_H

#include <Arduino.h>
#include <Audio.h>
#include <stdint.h>
#include "config.h"
#include "peak_eq.h"
#include "profile.h"

enum class DebugMode : uint8_t {
    NORMAL      = 0,
    PASSTHROUGH = 1,
    TONE        = 2,
    ADC_PRINT   = 3
};

class AudioEQStream : public AudioStream {
public:
    AudioEQStream() : AudioStream(1, _inputQueue) {}

    void loadProfile(const BandProfile *profile);
    void setGain(int band, float gainDB);
    void getProfile(BandProfile *profile) const;

    void setBypassed(bool b) { _bypassed = b; }
    void setSilent(bool s)   { _silent   = s; }
    void setAdcPrint(bool a) { _adcPrint = a; }

    virtual void update() override;

private:
    audio_block_t *_inputQueue[1];
    PeakEQ      _eqBands[NUM_BANDS];
    BandProfile _profile[NUM_BANDS];

    volatile bool _bypassed = false;
    volatile bool _silent   = false;
    volatile bool _adcPrint = false;

    float _runEQ(float x);
};

class AudioPipeline {
public:
    AudioInputI2S            i2sIn;
    AudioOutputI2S           i2sOut;
    AudioSynthWaveformSine   toneGen;
    AudioMixer4              inputMixer;
    AudioEQStream            eqStream;
    AudioControlSGTL5000     sgtl5000;

    void init();
    void setGain(int band, float gainDB);
    void loadProfile(const BandProfile *profile);
    void getProfile(BandProfile *profile) const;
    void setDebugMode(DebugMode mode);
    DebugMode getDebugMode() const { return _debugMode; }

private:
    DebugMode _debugMode = DebugMode::NORMAL;
    void _applyModeToHardware(DebugMode mode);
};

#endif // AUDIO_PIPELINE_H
