#!/usr/bin/env python3
"""Sets the per-design app identity in the native projects, so the three designs install side by side.
Usage: set-identity.py <slug> <display name> <ground colour>"""
import plistlib, re, sys
slug, label, ground = sys.argv[1], sys.argv[2], sys.argv[3]
p = 'ios/Dorkar.xcodeproj/project.pbxproj'; s = open(p).read()
s = re.sub(r'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;', f'PRODUCT_BUNDLE_IDENTIFIER = "com.dorkar.{slug}";', s)
open(p, 'w').write(s)
p = 'ios/Dorkar/Info.plist'
with open(p, 'rb') as f: d = plistlib.load(f)
d['CFBundleDisplayName'] = label
d['CFBundleURLTypes'] = [{'CFBundleURLSchemes': [f'dorkar-{slug}']}]
d.pop('NSLocationWhenInUseUsageDescription', None)
d['NSCameraUsageDescription'] = 'Take photos of what you are selling or offering.'
d['NSPhotoLibraryUsageDescription'] = 'Choose photos of what you are selling or offering.'
with open(p, 'wb') as f: plistlib.dump(d, f)
p = 'android/app/build.gradle'; s = open(p).read()
s = re.sub(r'applicationId "[^"]+"', f'applicationId "com.dorkar.{slug}"', s); open(p, 'w').write(s)
p = 'android/app/src/main/res/values/strings.xml'; s = open(p).read()
s = re.sub(r'(<string name="app_name">)[^<]*', rf'\g<1>{label}', s); open(p, 'w').write(s)
p = 'android/app/src/main/AndroidManifest.xml'; s = open(p).read()
s = re.sub(r'\s*<intent-filter android:label="links">.*?</intent-filter>', '', s, flags=re.S)
s = s.replace('      </activity>', f'''        <intent-filter android:label="links">
            <action android:name="android.intent.action.VIEW" />
            <category android:name="android.intent.category.DEFAULT" />
            <category android:name="android.intent.category.BROWSABLE" />
            <data android:scheme="dorkar-{slug}" />
        </intent-filter>
      </activity>''')
open(p, 'w').write(s)

# Launch screens: the design's plain ground, so opening the app never flashes the wrong colour.
r, g, b = (int(ground[i:i + 2], 16) / 255 for i in (1, 3, 5))
p = 'ios/Dorkar/LaunchScreen.storyboard'; s = open(p).read()
s = re.sub(r'\s*<subviews>.*?</subviews>', '', s, flags=re.S)
s = re.sub(r'\s*<constraints>.*?</constraints>', '', s, flags=re.S)
s = re.sub(r'<color key="backgroundColor"[^>]*/>', f'<color key="backgroundColor" red="{r:.4f}" green="{g:.4f}" blue="{b:.4f}" alpha="1" colorSpace="custom" customColorSpace="sRGB"/>', s)
open(p, 'w').write(s)
p = 'android/app/src/main/res/values/styles.xml'; s = open(p).read()
s = re.sub(r'\s*<item name="android:windowBackground">[^<]*</item>', '', s)
s = s.replace('</style>', f'    <item name="android:windowBackground">{ground}</item>\n    </style>', 1)
open(p, 'w').write(s)
