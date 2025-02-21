import asyncio
import logging

import numpy as np
from pytransform3d import transformations as pt
from pytransform3d import rotations as pr
import math

from astra_teleop.process import get_solve
from astra_teleop_web.webserver import WebServer

logger = logging.getLogger(__name__)

GRIPPER_MAX = 0.055
INITIAL_LIFT_DISTANCE = 0.8

FAR_SEEING_HEAD_TILT = 0.26

class Teleopoperator:
    def __init__(self):        
        self.webserver = WebServer()
        self.webserver.on_hand = self.hand_cb
        self.webserver.on_pedal = self.pedal_cb
        self.webserver.on_control = self.control_cb
        
        self.on_pub_goal = None
        self.on_pub_gripper = None
        self.on_pub_head = None
        self.on_cmd_vel = None
        
        self.on_get_current_eef_pose = None
        self.on_get_initial_eef_pose = None
        self.on_reset = None
        self.on_done = None
        
        self.teleop_mode = None
        
        self.percise_mode = False
        self.solve = get_solve(scale=1.0)
        
        self.lift_distance = INITIAL_LIFT_DISTANCE
        self.Tscam = { "left": None, "right": None, }
        self.Tcamgoal_last = { "left": None, "right": None }
        
    async def reset_Tscam(self):
        self.Tscam = { "left": None, "right": None, }
        self.Tcamgoal_last = { "left": None, "right": None }
        
        while True: # wait for new tag result
            ok = True
            for side in ["left", "right"]:
                if self.Tcamgoal_last[side] is None:
                    logger.info(f"Waiting for new Tcamgoal_last {side}")
                    ok = False
            if ok:
                break
            
            await asyncio.sleep(0.1)
            
        for side in ["left", "right"]:
            Tsgoal = self.on_get_current_eef_pose(side)
            Tcamgoal = self.Tcamgoal_last[side]
            self.Tscam[side] = Tsgoal @ np.linalg.inv(Tcamgoal)
            logger.info(f"Tscam ({side}): \n{str(self.Tscam[side])}")
                
    async def update_percise_mode(self, percise_mode):
        self.percise_mode = percise_mode
        self.solve = get_solve(scale=0.5 if self.percise_mode == "more_percise" else 1.0) # scale means to amplify motion
        await self.reset_Tscam()
        
    def update_teleop_mode(self, teleop_mode):
        self.teleop_mode = teleop_mode
        assert self.teleop_mode in ["base", "arm", None]
        if self.teleop_mode == "base":
            self.webserver.control_datachannel_log("Teleop Mode: Base Move")
            logger.info("Teleop Mode: Base Move")
        elif self.teleop_mode == "arm":
            if self.percise_mode == "more_percise":
                self.webserver.control_datachannel_log("Teleop Mode: More Percise Arm Move")
                logger.info("Teleop Mode: More Percise Arm Move")
            elif self.percise_mode:
                self.webserver.control_datachannel_log("Teleop Mode: Percise Arm Move")
                logger.info("Teleop Mode: Percise Arm Move")
            else:
                self.webserver.control_datachannel_log("Teleop Mode: Arm Move")
                logger.info("Teleop Mode: Arm Move")
        else:
            self.webserver.control_datachannel_log("Teleop Mode: None")
            logger.info("Teleop Mode: None")

    async def reset_arm(self, lift_distance=INITIAL_LIFT_DISTANCE, joint_bent=math.pi/4, far_seeing=False):  
        self.lift_distance = lift_distance
        goal_pose = {
            "left": self.on_get_initial_eef_pose("left", [self.lift_distance, joint_bent, -joint_bent, 0, 0, 0]),
            "right": self.on_get_initial_eef_pose("right", [self.lift_distance, -joint_bent, joint_bent, 0, 0, 0]),
        }

        while True:
            ok = True
            for side in ["left", "right"]:
                curr_pose = self.on_get_current_eef_pose(side)
                
                goal_pose_pq = pt.pq_from_transform(goal_pose[side])
                curr_pose_pq = pt.pq_from_transform(curr_pose)
                
                pos_dist = math.dist(goal_pose_pq[:3], curr_pose_pq[:3])
                rot_dist = pr.quaternion_dist(
                    goal_pose_pq[3:],
                    curr_pose_pq[3:]
                )
            
                if not (pos_dist < 0.02 and rot_dist < 0.03):
                    logger.info(f"Resetting {side}: pos_dist {pos_dist}m, rot_dist {rot_dist}rad, curr_pose: \n{curr_pose}")
                    ok = False            
            if ok:
                break
            
            for side in ["left", "right"]:
                self.on_pub_goal(side, goal_pose[side])
                self.on_pub_gripper(side, GRIPPER_MAX)
            
            if far_seeing:
                self.on_pub_head(0, FAR_SEEING_HEAD_TILT)
            else:
                self.on_pub_head(0, self.get_head_tilt(self.lift_distance))
            
            await asyncio.sleep(0.1)

    def get_head_tilt(self, lift_distance):
        point0_lift = 0
        point0_tilt = 1.36
        point1_lift = 0.8
        point1_tilt = 1.06
        
        return point0_tilt + (point1_tilt - point0_tilt) * (lift_distance - point0_lift) / (point1_lift - point0_lift)

    def hand_cb(self, camera_matrix, distortion_coefficients, corners, ids):
        Tcamgoal = {}

        Tcamgoal["left"], Tcamgoal["right"] = self.solve(
            camera_matrix, distortion_coefficients,
            aruco_corners=corners, aruco_ids=ids,
            debug=False,
            debug_image=None,
        ) # 1ms@1080p
        
        for side in ["left", "right"]:
            if Tcamgoal[side] is not None:
                if self.Tcamgoal_last[side] is None:
                    self.Tcamgoal_last[side] = Tcamgoal[side]

                if self.percise_mode:
                    # low_pass_coff = 0.1
                    # Tcamgoal[side] = pt.transform_from_pq(pt.pq_slerp(
                    #     pt.pq_from_transform(self.Tcamgoal_last[side]),
                    #     pt.pq_from_transform(Tcamgoal[side]),
                    #     low_pass_coff
                    # ))

                    # trust for sensor read (in this case, opencv on web client)
                    p_low_pass_coff = 0.1
                    q_low_pass_coff = 0.1
                    pq_camgoal_last = pt.pq_from_transform(self.Tcamgoal_last[side])
                    pq_camgoal = pt.pq_from_transform(Tcamgoal[side])
                    p = pq_camgoal_last[:3] * (1 - p_low_pass_coff) + pq_camgoal[:3] * p_low_pass_coff
                    q = pr.quaternion_slerp(pq_camgoal_last[3:], pq_camgoal[3:], q_low_pass_coff, shortest_path=True)
                    Tcamgoal[side] = pt.transform_from_pq(np.concatenate([p, q]))

                self.Tcamgoal_last[side] = Tcamgoal[side]

        if self.teleop_mode == "arm":
            for side in ["left", "right"]:
                if self.Tcamgoal_last[side] is None:
                    self.webserver.control_datachannel_log(f"Connect capture and making sure {side} are in the camera view!")
                    raise Exception(f"Connect capture and making sure {side} are in the camera view!")

            for side in ["left", "right"]:
                if self.Tscam[side] is None:
                    self.webserver.control_datachannel_log(f"Reset {side} arm first!")
                    raise Exception(f"Reset {side} arm first!")
            
            for side in ["left", "right"]:
                Tsgoal = self.Tscam[side] @ self.Tcamgoal_last[side]
                self.on_pub_goal(side, Tsgoal if self.teleop_mode == "arm" else None, Tscam=self.Tscam[side], Tsgoal_inactive=Tsgoal)
        
            self.on_pub_head(0, self.get_head_tilt(self.lift_distance))
        
    def pedal_cb(self, pedal_real_values):
        pedal_names = ["angular-pos", "angular-neg", "linear-neg", "linear-pos"]
        pedal_names_arm_mode = ["left-gripper", "lift-neg", "lift-pos", "right-gripper"]
        non_sensetive_area = 0.1
        cliped_pedal_real_values = np.clip((np.array(pedal_real_values) - 0.5) / (0.5 - non_sensetive_area) * 0.5 + 0.5, 0, 1)
        if self.teleop_mode == "arm":
            values = dict(zip(pedal_names_arm_mode, cliped_pedal_real_values))

            LIFT_VEL_MAX = 0.5
            lift_vel = (values["lift-pos"] - values["lift-neg"]) * LIFT_VEL_MAX

            TIME_DELTA = 0.1 # TODO Better solution
            change = lift_vel * TIME_DELTA

            LIFT_DISTANCE_MIN = 0
            LIFT_DISTANCE_MAX = 1.2
            if self.lift_distance + change < LIFT_DISTANCE_MIN or self.lift_distance + change > LIFT_DISTANCE_MAX:
                self.webserver.control_datachannel_log("Lift over limit")
                logger.warn("Lift over limit")
            elif change:
                self.Tscam["left"][2,3] += change
                self.Tscam["right"][2,3] += change
                self.lift_distance += change
                logger.info("lift_distance changed")
                logger.info(str(self.lift_distance))
            
            left_gripper_pos = (1 - values["left-gripper"]) * GRIPPER_MAX
            right_gripper_pos = (1 - values["right-gripper"]) * GRIPPER_MAX
            
            self.on_pub_gripper("left", left_gripper_pos)
            self.on_pub_gripper("right", right_gripper_pos)
        elif self.teleop_mode == "base":
            values = dict(zip(pedal_names, cliped_pedal_real_values))

            LINEAR_VEL_MAX = 1
            ANGULAR_VEL_MAX = 1
            linear_vel = (values["linear-pos"] - values["linear-neg"]) * LINEAR_VEL_MAX
            angular_vel = (values["angular-pos"] - values["angular-neg"]) * ANGULAR_VEL_MAX * (-1 if linear_vel < 0 else 1)

            self.on_cmd_vel(linear_vel, angular_vel)
            self.on_pub_head(0, FAR_SEEING_HEAD_TILT)
    
    async def control_cb(self, control_type):
        self.webserver.control_datachannel_log(f"Cmd: {control_type}")
        logger.info(f"Cmd: {control_type}")
        if control_type == "reset":
            self.update_teleop_mode(None)
            await self.reset_arm(INITIAL_LIFT_DISTANCE, math.pi/4, far_seeing=False)
            self.on_reset()
            self.webserver.control_datachannel_log("Reset event")
        elif control_type == "done":
            self.on_done()
            self.webserver.control_datachannel_log("Done event")
            logger.info("Done event")
        elif control_type == "teleop_mode_none":
            self.update_teleop_mode(None)
        elif control_type == "teleop_mode_base":
            self.update_teleop_mode(None)
            await self.reset_arm(self.lift_distance, math.pi/2*0.9, far_seeing=True)
            self.update_teleop_mode("base")
        elif control_type == "teleop_mode_arm":
            self.update_teleop_mode(None)            
            await self.reset_arm(self.lift_distance, math.pi/4, far_seeing=False)
            await self.update_percise_mode(percise_mode=True)
            self.update_teleop_mode("arm")
        elif control_type == "percise_mode_false":
            self.update_teleop_mode(None)
            await self.update_percise_mode(percise_mode=False)
            self.update_teleop_mode("arm")
        elif control_type == "percise_mode_true":
            self.update_teleop_mode(None)
            await self.update_percise_mode(percise_mode=True)
            self.update_teleop_mode("arm")
        elif control_type == "percise_mode_more_percise":
            self.update_teleop_mode(None)
            await self.update_percise_mode(percise_mode="more_percise")
            self.update_teleop_mode("arm")
            
    def ik_failed_cb(self, side):
        self.webserver.loop.call_soon_threadsafe(self.webserver.control_datachannel_log, f"IK failed: {side}")
        logger.info(f"IK failed: {side}")
