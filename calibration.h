#ifndef CALIBRATION_H
#define CALIBRATION_H

// ============================================================================
// calibration.h
//
// The Calibration class runs a full automated audiometry sequence on the
// Teensy.  It sweeps a tone at each of the NUM_BANDS centre frequencies,
// starting at a very low amplitude and ramping up step by step.  The user
// presses BUTTON_PIN to GND the moment they hear the tone.  The amplitude at
// that threshold is used to compute how much gain that band needs, and the
// result is written back into the live AudioPipeline.
//
// Hardware required
// -----------------
//  • Headphones connected to the 3.5 mm stereo jack on the Teensy Audio Shield.
//  • Optional wire from BUTTON_PIN to GND (or use web interface "I Hear It" button).
//    BUTTON_PIN is configured INPUT_PULLUP, so the resting state is HIGH and a
//    press pulls it LOW.
//
// Calibration flow (per band)
// ----------------------------
//  1. Switch the pipeline to TONE mode at the band's centre frequency.
//  2. Play the tone at the current amplitude for CAL_TONE_MS milliseconds,
//     polling BUTTON_PIN and WebSerial. If pressed/sent → heard, record amplitude, move on.
//  3. Silence for CAL_SILENCE_MS milliseconds, still polling.
//     (Some users react slightly after the tone ends.)
//  4. Increment amplitude by CAL_STEP_AMP and repeat from step 2.
//  5. If CAL_MAX_AMP is reached without a press → band needs no correction,
//     gain = 0 dB.
//
// Gain calculation
// ----------------
//  The reference amplitude is CAL_START_AMP (the quietest level played).
//  When the user hears the tone at amplitude A:
//
//    gainDB = 20 * log10(A / CAL_START_AMP)
//
//  This is positive (boost) when A > CAL_START_AMP — the user needed more
//  volume to hear the tone, so the hearing aid must amplify that band.
//  The result is capped at CAL_MAX_GAIN_DB.
//
//  If the user heard the tone immediately at CAL_START_AMP the gain is 0 dB.
// ============================================================================

#include "audio_pipeline.h"
#include "profile.h"
#include "config.h"

class Calibration {
public:

    // -------------------------------------------------------------------------
    // Constructor
    // Stores a reference to the live AudioPipeline so calibration results can
    // be applied directly without copying data through global variables.
    // -------------------------------------------------------------------------
    explicit Calibration(AudioPipeline &pipeline);

    // -------------------------------------------------------------------------
    // isRequested
    //
    // Returns true if BUTTON_PIN is held LOW when called.
    // Call this from setup() during the boot window to decide whether to run
    // the calibration sequence before starting normal audio operation.
    //
    // Example usage in setup():
    //   if (calibration.isRequested()) calibration.run();
    // -------------------------------------------------------------------------
    bool isRequested();

    // -------------------------------------------------------------------------
    // run
    //
    // Execute the full audiometry sequence for all NUM_BANDS frequency bands.
    //
    // What it does:
    //   1. Prints a header and waits 2 seconds so the user can get ready.
    //   2. For each band, calls measureThreshold() to find the hearing
    //      threshold amplitude.
    //   3. Converts each threshold to a gain in dB.
    //   4. Loads the resulting profile into the AudioPipeline via loadProfile().
    //   5. Prints the final calibrated profile table.
    //   6. Restores the pipeline to NORMAL mode.
    //
    // AudioMemory() and AudioPipeline::init() must already have been called before
    // calling run() so that the internal tone generator plays through the codec.
    // -------------------------------------------------------------------------
    void run();

private:

    AudioPipeline &_pipeline;

    // -------------------------------------------------------------------------
    // measureThreshold
    //
    // Play a tone at freqHz, ramping the amplitude from CAL_START_AMP to
    // CAL_MAX_AMP in steps of CAL_STEP_AMP.
    //
    // At each amplitude step:
    //   • Play the tone for CAL_TONE_MS ms (polling BUTTON_PIN).
    //   • Silence for CAL_SILENCE_MS ms (still polling — late reactions count).
    //
    // Returns the amplitude at which the button was pressed.
    // Returns 0.0f if the button was never pressed (band assumed normal).
    // -------------------------------------------------------------------------
    float measureThreshold(float freqHz);

    // -------------------------------------------------------------------------
    // waitForButton
    //
    // Block for up to timeoutMs milliseconds, returning true the moment
    // BUTTON_PIN goes LOW (with CAL_DEBOUNCE_MS debounce).
    // Returns false if the timeout expires without a press.
    // -------------------------------------------------------------------------
    bool waitForButton(uint32_t timeoutMs);
};

#endif // CALIBRATION_H
