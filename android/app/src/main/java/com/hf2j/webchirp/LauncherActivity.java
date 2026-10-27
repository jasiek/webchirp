/*
 * Copyright 2020 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.hf2j.webchirp;

import android.content.pm.ActivityInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;


    import android.content.SharedPreferences;

    import android.os.StrictMode;


public class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {
    
        private static final String KEY_FIRST_OPEN = "bubblewrap.first_open";
    
        private static final String PARAM_FIRST_OPEN = "android_app_first_open";
    

    
        private boolean checkAndMarkFirstOpen() {
           StrictMode.ThreadPolicy originalPolicy = StrictMode.allowThreadDiskReads();
           try {
               SharedPreferences preferences = getPreferences(MODE_PRIVATE);
               boolean isFirstRun = preferences.getBoolean(KEY_FIRST_OPEN, true);
               preferences.edit().putBoolean(KEY_FIRST_OPEN, false).apply();
               return isFirstRun;
           } finally {
               StrictMode.setThreadPolicy(originalPolicy);
           }
        }
    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Setting an orientation crashes the app due to the transparent background on Android 8.0
        // Oreo and below. We only set the orientation on Oreo and above. This only affects the
        // splash screen and Chrome will still respect the orientation.
        // See https://github.com/GoogleChromeLabs/bubblewrap/issues/496 for details.
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.O) {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        } else {
            setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        }
    }

    @Override
    protected Uri getLaunchingUrl() {
        // Get the original launch Url.
        Uri uri = super.getLaunchingUrl();

        
            uri = uri
      .buildUpon()
      .appendQueryParameter(PARAM_FIRST_OPEN, String.valueOf(checkAndMarkFirstOpen()))
      .build();
        

        return uri;
    }
}
