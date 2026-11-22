import ActivityKit
import Foundation
import SwiftUI
import UIKit
import DSHCore

@MainActor final class TaskPushSettings: ObservableObject {
    typealias Island = Activity<DSHTaskAttributes>
    struct Row: Decodable { let remoteStarting:Bool; let sessionId: String; let content: DSHTaskAttributes.ContentState
        enum Keys:String,CodingKey {case sessionId,remoteStarting}
        init(from decoder: Decoder) throws { remoteStarting = try decoder.container(keyedBy:Keys.self).decodeIfPresent(Bool.self,forKey:.remoteStarting) ?? false; sessionId = try decoder.container(keyedBy:Keys.self).decode(String.self,forKey:.sessionId); content = try .init(from: decoder) }
    }
    struct Status: Decodable { let relay:Bool; let bark:Bool; let island:Bool; let tasks:[Row] }
    @Published private(set) var bark = false
    @Published private(set) var island = false
    @Published private(set) var relay = false
    @Published private(set) var busy = false
    @Published private(set) var message = ""
    private var current: PairedDesktop?, transport: PinnedTransport?, endpoint: Endpoint?
    private var loop: Task<Void,Never>?, starts: Task<Void,Never>?, arrivals: Task<Void,Never>?
    private var observers = [String:Task<Void,Never>](), uploaded = [String:String]()
    private var foreground = true

    func bind(_ desk: PairedDesktop?, _ channel: PinnedTransport?) {
        if let old=current?.id,old != desk?.id {for a in Island.activities where a.attributes.desktopId==old { Task {await a.end(nil,dismissalPolicy:.immediate)} }}
        loop?.cancel(); stopObserving(); uploaded.removeAll(); current=desk; transport=channel; endpoint=desk?.preferred ?? desk?.endpoints.first
        bark=false; island=false; relay=false; busy=false; message=""
        if let desk, UserDefaults.standard.bool(forKey:"dsh.island."+desk.id) { island=true;relay=true;observe();Task {await reconcileTokens()} };poll()
    }
    func connected(_ ep: Endpoint) { endpoint=ep; poll() }
    func scene(_ active: Bool) { foreground=active; if active { poll() } else { loop?.cancel();if island {Task {_ = try? await request(["op":"background"])}} } }
    private func stopObserving(){ starts?.cancel(); starts=nil; arrivals?.cancel(); arrivals=nil; for t in observers.values {t.cancel()}; observers.removeAll() }
    private func request(_ body: [String:Any]? = nil) async throws -> Data {
        guard let desk=current,let channel=transport,let endpoint else { throw URLError(.notConnectedToInternet) }
        var req=URLRequest(url:endpoint.baseURL.appendingPathComponent("mobile/v1/task-notifications"),cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:7)
        req.setValue("Bearer \(desk.token)",forHTTPHeaderField:"Authorization")
        if let body { req.httpMethod="POST";req.setValue("application/json",forHTTPHeaderField:"Content-Type");req.httpBody=try JSONSerialization.data(withJSONObject:body) }
        let (data,response)=try await channel.session.data(for:req)
        guard current?.id==desk.id,(response as? HTTPURLResponse)?.statusCode==200 else {throw URLError(.badServerResponse)};return data
    }
    func configure(_ body:[String:Any]) {guard !busy else{return};busy=true;let id=current?.id
        Task { do { _=try await request(body);guard current?.id==id else{return};message=(body["op"] as? String)=="test" ? "Bark 服务端已接受测试通知，请检查手机。" : "设置已保存";await refresh() }
               catch { if current?.id==id {message="未保存：请检查电脑连接、插件版本和推送服务配置。"} };if current?.id==id {busy=false} }
    }
    func poll(){loop?.cancel();guard foreground,current != nil else{return};loop=Task { [weak self] in
        while !Task.isCancelled {guard let self else{return};await self.refresh();guard self.island else{return};try? await Task.sleep(nanoseconds:3_000_000_000) }
    }}
    private func refresh() async {
        guard let desk=current,let data=try? await request(),!Task.isCancelled,current?.id==desk.id,
              let status=try? JSONDecoder().decode(Status.self,from:data) else{return}
        // A background push-to-start can wake the app before the WebView or LAN route is ready.
        let was=island; bark=status.bark;island=status.island;relay=status.relay;UserDefaults.standard.set(island && relay,forKey:"dsh.island."+desk.id)
        guard island else {stopObserving(); if was {for a in Island.activities where a.attributes.desktopId==desk.id {await a.end(nil,dismissalPolicy:.immediate)}};return}
        observe();await reconcileTokens();guard ActivityAuthorizationInfo().areActivitiesEnabled else {message="系统未允许实时活动，可在系统设置中开启。";return}
        for row in status.tasks { if Task.isCancelled || current?.id != desk.id{return};await apply(row, desk.id) }
        if !was && foreground {poll()}
    }
    private func apply(_ r:Row,_ desk:String) async {let s=r.content
        let content=ActivityContent(state:s,staleDate:Date().addingTimeInterval(180))
        if let a=Island.activities.first(where:{$0.attributes.desktopId==desk && $0.attributes.sessionId==r.sessionId && $0.attributes.turn==s.turn}) {
            if s.terminal && !a.content.state.terminal {await a.end(content,dismissalPolicy:s.phase=="completed" ? .immediate : .after(.now.addingTimeInterval(300)))}
            else if a.content.state.updatedAt<s.updatedAt {await a.update(content)}
        } else if !s.terminal && !r.remoteStarting && foreground && UIApplication.shared.applicationState == .active {
            let attrs=DSHTaskAttributes(desktopId:desk,sessionId:r.sessionId,turn:s.turn)
            do {let a=try Island.request(attributes:attrs,content:content,pushType:relay ? .token:nil);watch(a)}
            catch {message="实时活动未能启动，请检查系统权限及应用签名。"}
        }
    }
    private func register(_ key:String,_ token:Data,_ args:[String:Any]) async {
        let text=token.map{String(format:"%02x",$0)}.joined();guard uploaded[key] != text else{return};var b=args;b["token"]=text
        do {_=try await request(b);uploaded[key]=text} catch {} // Retry current tokens during the next foreground sync.
    }
    private func watch(_ a:Island){guard relay,a.attributes.desktopId==current?.id,observers[a.id]==nil else{return};observers[a.id]=Task { [weak self] in
        let args:[String:Any]=["op":"activity","sessionId":a.attributes.sessionId,"turn":a.attributes.turn];if let t=a.pushToken {await self?.register(a.id,t,args)}
        for await t in a.pushTokenUpdates {if Task.isCancelled {break};await self?.register(a.id,t,args)}
    }}
    private func observe(){guard relay else{return}; if #available(iOS 17.2, *), starts==nil {starts=Task {[weak self] in
        for await token in Island.pushToStartTokenUpdates {if Task.isCancelled {break};await self?.register("start",token,["op":"startToken"])}
    }}
        if arrivals==nil {arrivals=Task {[weak self] in for await a in Island.activityUpdates {if Task.isCancelled{break};self?.watch(a)} }}
        let ids=Set(Island.activities.map(\.id))
        for key in Array(observers.keys) where !ids.contains(key) {observers.removeValue(forKey:key)?.cancel();uploaded.removeValue(forKey:key)}
        for a in Island.activities {watch(a)}
    }
    func reconcileTokens() async {guard island,relay else{return};if #available(iOS 17.2,*),let token=Island.pushToStartToken {await register("start",token,["op":"startToken"])}
        for a in Island.activities where a.attributes.desktopId==current?.id {if let t=a.pushToken {await register(a.id,t,["op":"activity","sessionId":a.attributes.sessionId,"turn":a.attributes.turn])}}
    }
}

struct TaskPushSection: View {
    @ObservedObject var settings: TaskPushSettings
    @State private var key=""
    var body: some View { Section("任务推送与灵动岛") {
        SecureField("Bark 设备 Key（不是配对码）",text:$key).textInputAutocapitalization(.never).autocorrectionDisabled()
        Button(settings.bark ? "更新 Bark 设备" : "启用 Bark 通知"){settings.configure(["op":"bark","key":key]);key=""}.disabled(settings.busy || key.isEmpty)
        if settings.bark {Button("发送一条测试通知"){settings.configure(["op":"test"])}.disabled(settings.busy);Button("停用 Bark 通知"){settings.configure(["op":"bark","key":""]) }.disabled(settings.busy)}
        Toggle("锁屏实时活动 / 灵动岛",isOn:Binding(get:{settings.island},set:{settings.configure(["op":"island","enabled":$0])})).disabled(settings.busy)
        Text(settings.message.isEmpty ? (settings.relay ? "只推送状态、轮次及步骤，不发送聊天正文。" : "未发现云推送配置；实时活动仍可在应用打开时更新。") : settings.message).font(.footnote).foregroundStyle(.secondary)
    }.onAppear{settings.poll()} }
}
