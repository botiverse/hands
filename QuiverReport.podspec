Pod::Spec.new do |s|
  s.name             = 'QuiverReport'
  s.version          = '0.1.0'
  s.summary          = 'Quiver feedback + crash reporting for iOS.'
  s.description      = <<-DESC
    Native iOS reporting layer for Quiver: in-app feedback tickets
    (multipart with attachments and automatic device metadata) and
    store-then-send crash reporting (uncaught NSExceptions and fatal
    signals, uploaded as crash tickets on the next launch). Configured at
    runtime — base URL, app slug, channel, and client key are init
    parameters, never compiled into the SDK.
  DESC
  s.homepage         = 'https://github.com/oranix-io/quiver'
  s.license          = { :type => 'MIT' }
  s.author           = { 'Oranix' => 'artin@cat.ms' }
  s.source           = { :git => 'https://github.com/oranix-io/quiver.git', :tag => "ios-v#{s.version}" }

  s.ios.deployment_target = '14.1'
  s.source_files     = 'clients/ios/Sources/QuiverReport/**/*.{h,m}'
  s.public_header_files = 'clients/ios/Sources/QuiverReport/QuiverReport.h'
  s.frameworks       = 'Foundation', 'UIKit'
  s.requires_arc     = true
end
