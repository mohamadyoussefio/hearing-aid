#ifndef CALIBRATION_H
#define CALIBRATION_H

#include "audio_pipeline.h"
#include "profile.h"
#include "config.h"

class Calibration {
public:
    explicit Calibration(AudioPipeline &pipeline);
    bool isRequested();
    void run();

private:
    AudioPipeline &_pipeline;
    float measureThreshold(float freqHz);
    bool waitForButton(uint32_t timeoutMs);
};

#endif // CALIBRATION_H
