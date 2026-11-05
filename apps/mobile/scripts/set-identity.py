#!/usr/bin/env python3
"""Sets the per-design app identity in the native projects, so the three designs install side by side."""
import plistlib, re, sys
slug, label = sys.argv[1], sys.argv[2]
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
