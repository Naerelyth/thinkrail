%global debug_package %{nil}
%global __os_install_post %{nil}
%global _build_id_links none

Name:           %{package_name}
Version:        %{app_version}
Release:        %{package_release}
Summary:        The agentic IDE built around pi
License:        Apache-2.0
URL:            https://thinkrail.ai
Source0:        payload.tar.gz
ExclusiveArch:  x86_64 aarch64
AutoProv:       no
AutoReq:        yes
Requires:       git
Requires:       xdg-utils
Requires:       glibc >= 2.38
Requires:       libgtk-3.so.0()(64bit)
Requires:       libwebkit2gtk-4.1.so.0()(64bit)
Requires:       libayatana-appindicator3.so.1()(64bit)
Requires:       librsvg-2.so.2()(64bit)

%description
ThinkRail runs the pi coding agent in a native desktop IDE with isolated
workspaces, conversations, terminals, editors and living project specs.

%prep
%setup -q -n payload

%build

%install
mkdir -p "%{buildroot}/opt/%{name}" "%{buildroot}%{_bindir}"
cp -a AppRun .thinkrail-update-method lib "%{buildroot}/opt/%{name}/"
ln -s "/opt/%{name}/AppRun" "%{buildroot}%{_bindir}/%{name}"
install -Dm644 "%{name}.desktop" "%{buildroot}%{_datadir}/applications/%{name}.desktop"
install -Dm644 "%{name}.png" "%{buildroot}%{_datadir}/pixmaps/%{name}.png"

%files
%defattr(-,root,root,-)
%license LICENSE
/opt/%{name}
%{_bindir}/%{name}
%{_datadir}/applications/%{name}.desktop
%{_datadir}/pixmaps/%{name}.png
