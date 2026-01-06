#include <Arduino.h>
#include "config.h"

// ============================================================================
// HearingAid.ino — Teensy 4.0 Digital Hearing Aid
// ============================================================================

void setup() {
    Serial.begin(115200);
    delay(500);

    Serial.println(F("============================================"));
    Serial.println(F("      Teensy Hearing Aid  (Audio Shield)    "));
    Serial.println(F("============================================"));
}

void loop() {
    delay(10);
}
