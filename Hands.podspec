Pod::Spec.new do |s|
  s.name             = 'Hands'
  s.version          = '0.2.2'
  s.summary          = 'Hands feedback + crash reporting for iOS.'
  s.description      = <<-DESC
    Native iOS reporting layer for Hands: in-app feedback tickets
    (multipart with attachments and automatic device metadata) and
    store-then-send crash reporting (uncaught NSExceptions and fatal
    signals, uploaded as crash tickets on the next launch). Configured at
    runtime — base URL, app slug, channel, and client key are init
    parameters, never compiled into the SDK.
  DESC
  s.homepage         = 'https://github.com/oranix-io/hands'
  s.license          = { :type => 'MIT', :file => 'LICENSE' }
  s.author           = { 'Oranix' => 'artin@cat.ms' }
  s.source           = { :git => 'https://github.com/oranix-io/hands.git', :tag => "ios-v#{s.version}" }

  s.ios.deployment_target = '14.1'
  s.source_files     = 'clients/ios/Sources/Hands/**/*.{h,m,c}'
  s.public_header_files = 'clients/ios/Sources/Hands/Hands.h'
  s.frameworks       = 'Foundation', 'UIKit'
  s.requires_arc     = true

  # Run on a simulator: pod lib lint Hands.podspec --run-tests --platforms=ios
  s.test_spec 'Tests' do |t|
    t.source_files = 'clients/ios/Tests/HandsTests/**/*.{h,m}'
    t.frameworks   = 'XCTest'
  end
end
