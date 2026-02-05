#include "calibration.h"
#include "config.h"
#include <Arduino.h>
#include <math.h>

// ============================================================================
// calibration.cpp
//
// Implements the audiometry calibration sequence.
//
// The flow for each band:
//   1. Set the pipeline to TONE mode at the band frequency.
//   2. Ramp amplitude from CAL_START_AMP to CAL_MAX_AMP in steps.
//   3. At each step: play tone for CAL_TONE_MS ms, then silence for
//      CAL_SILENCE_MS ms, polling BUTTON_PIN throughout.
//   4. When the button is pressed, record the amplitude and move on.
//   5. After all bands, compute gains, load the profile, restore NORMAL mode.
// ============================================================================


// ----------------------------------------------------------------------------
// Constructor
// ----------------------------------------------------------------------------
Calibration::Calibration(AudioPipeline &pipeline)
    : _pipeline(pipeline)
{
    pinMode(BUTTON_PIN, INPUT_PULLUP);
}


// ----------------------------------------------------------------------------
// isRequested
// Returns true if BUTTON_PIN is already held LOW at boot.
// ----------------------------------------------------------------------------
bool Calibration::isRequested() {
    return (digitalRead(BUTTON_PIN) == LOW);
}


// ----------------------------------------------------------------------------
// waitForButton
//
// Polls BUTTON_PIN for up to timeoutMs milliseconds.
// Returns true as soon as a stable LOW is detected (with debounce).
// Returns false if the timeout expires.
// ----------------------------------------------------------------------------
bool Calibration::waitForButton(uint32_t timeoutMs) {
    uint32_t deadline = millis() + timeoutMs;

    while (millis() < deadline) {
        // ---- Physical button (BUTTON_PIN pulled LOW) ----
        if (digitalRead(BUTTON_PIN) == LOW) {
            // Debounce: confirm still LOW after CAL_DEBOUNCE_MS
            delay(CAL_DEBOUNCE_MS);
            if (digitalRead(BUTTON_PIN) == LOW) {
                // Wait for release before returning so the next step
                // does not immediately detect the same press
                uint32_t releaseDeadline = millis() + 3000;
                while (digitalRead(BUTTON_PIN) == LOW && millis() < releaseDeadline) {
                    delay(10);
                }
                delay(CAL_DEBOUNCE_MS);  // settle after release
                return true;
            }
        }

        // ---- Web interface serial command "HEARD" ----
        // The browser sends this when the user clicks "I Hear It".
        // We check Serial here because calibration.run() is blocking and
        // the normal loop() serial parser never runs during calibration.
        if (Serial.available()) {
            String line = Serial.readStringUntil('\n');
            line.trim();
            Serial.print(F("> "));
            Serial.println(line);
            if (line.equalsIgnoreCase(F("HEARD"))) {
                return true;
            }
            // Any other command received during calibration is silently
            // ignored — we cannot safely handle it mid-sweep.
        }
    }
    return false;
}


// ----------------------------------------------------------------------------
// measureThreshold
//
// Sweeps the tone at freqHz from CAL_START_AMP to CAL_MAX_AMP.
// Returns the amplitude at which the button was first pressed,
// or 0.0f if the full sweep completed without a press.
// ----------------------------------------------------------------------------
float Calibration::measureThreshold(float freqHz) {
    float amp = CAL_START_AMP;

    while (amp <= CAL_MAX_AMP + 1e-6f) {

        // --- Tone burst ---
        _pipeline.setToneParams(freqHz, amp);
        _pipeline.setDebugMode(DebugMode::TONE);

        Serial.print(F("    amp="));
        Serial.print(amp, 3);
        Serial.print(F("  playing..."));

        if (waitForButton(CAL_TONE_MS)) {
            Serial.println(F("  HEARD"));
            return amp;
        }

        // --- Silence gap ---
        // Set amplitude to 0 but keep TONE mode so the ISR runs cleanly
        _pipeline.setToneParams(freqHz, 0.0f);

        Serial.println(F("  (silence)"));

        if (waitForButton(CAL_SILENCE_MS)) {
            Serial.println(F("  HEARD (during silence)"));
            return amp;
        }

        amp += CAL_STEP_AMP;
    }

    // Never heard — no correction needed for this band
    return 0.0f;
}


// ----------------------------------------------------------------------------
// run
//
// Full audiometry sequence across all NUM_BANDS frequency bands.
// Applies the computed gains to the pipeline before returning.
// ----------------------------------------------------------------------------
void Calibration::run() {

    Serial.println(F(""));
    Serial.println(F("================================================"));
    Serial.println(F("          AUDIOMETRY CALIBRATION"));
    Serial.println(F("================================================"));
    Serial.println(F("  For each frequency you will hear a tone that"));
    Serial.println(F("  gradually gets louder."));
    Serial.println(F("  The moment you hear it, touch BUTTON_PIN to GND."));
    Serial.println(F("  Starting in 3 seconds — get ready..."));
    Serial.println(F("================================================"));
    delay(3000);

    // Collect the hearing threshold amplitude for each band
    float thresholds[NUM_BANDS];

    for (int i = 0; i < NUM_BANDS; i++) {
        float freqHz = DEFAULT_PROFILE[i].freqHz;

        Serial.println(F("------------------------------------------------"));
        Serial.print(F("  Band "));
        Serial.print(i);
        Serial.print(F(" — "));
        Serial.print(freqHz, 0);
        Serial.println(F(" Hz"));

        thresholds[i] = measureThreshold(freqHz);

        if (thresholds[i] > 0.0f) {
            Serial.print(F("  Threshold: "));
            Serial.print(thresholds[i], 3);
            Serial.println(F(" (button pressed)"));
        } else {
            Serial.println(F("  Threshold: not reached — band set to 0 dB"));
        }

        // Brief pause between bands so the user is ready for the next one
        _pipeline.setToneParams(freqHz, 0.0f);
        delay(1000);
    }

    // --- Silence after the last band ---
    _pipeline.setToneParams(0.0f, 0.0f);

    // -------------------------------------------------------------------------
    // Compute gains from thresholds and build the new profile
    //
    // If the user heard the tone at amplitude A, they needed that much volume
    // to detect it.  The gain required to bring that threshold down to the
    // quietest level we played (CAL_START_AMP) is:
    //
    //   gainDB = 20 * log10(A / CAL_START_AMP)
    //
    // This is positive (boost) when A > CAL_START_AMP, meaning the user
    // needed more volume — the hearing aid must amplify that band.
    //
    // If the threshold was not reached (threshold == 0) the user hears fine
    // at that frequency — no correction is needed, gain stays 0 dB.
    // -------------------------------------------------------------------------
    BandProfile newProfile[NUM_BANDS];

    Serial.println(F("================================================"));
    Serial.println(F("  COMPUTED GAINS"));
    Serial.println(F("------------------------------------------------"));

    for (int i = 0; i < NUM_BANDS; i++) {
        // Preserve frequency and Q from the default profile
        newProfile[i].freqHz = DEFAULT_PROFILE[i].freqHz;
        newProfile[i].Q      = DEFAULT_PROFILE[i].Q;

        if (thresholds[i] <= CAL_START_AMP + 1e-6f) {
            // Heard immediately at the quietest level — no boost needed
            newProfile[i].gainDB = 0.0f;
        } else {
            float gainDB = 20.0f * log10f(thresholds[i] / CAL_START_AMP);

            // Cap to prevent excessive amplification
            if (gainDB > CAL_MAX_GAIN_DB) gainDB = CAL_MAX_GAIN_DB;

            newProfile[i].gainDB = gainDB;
        }

        Serial.print(F("  Band "));
        Serial.print(i);
        Serial.print(F(" ("));
        Serial.print(newProfile[i].freqHz, 0);
        Serial.print(F(" Hz)  threshold="));
        Serial.print(thresholds[i], 3);
        Serial.print(F("  gain=+"));
        Serial.print(newProfile[i].gainDB, 1);
        Serial.println(F(" dB"));
    }

    // Apply the calibrated profile to the live pipeline
    _pipeline.loadProfile(newProfile);

    Serial.println(F("================================================"));
    Serial.println(F("  Calibrated profile applied:"));
    _pipeline.printCurrentProfile();

    // Restore normal hearing-aid operation
    _pipeline.setDebugMode(DebugMode::NORMAL);

    Serial.println(F("  Calibration complete. Hearing aid is running."));
    Serial.println(F("================================================"));
    Serial.println(F(""));
}
